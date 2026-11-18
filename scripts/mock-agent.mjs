// Deterministic ACP fixture, explicitly marked in the UI. Never calls a model.
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const sessions = new Map();
if (process.env.MOCK_STDERR) console.error(process.env.MOCK_STDERR, process.env.MOCK_TOKEN ?? "");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const announceCommands = (client, sessionId) =>
  client.notify(acp.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "mcp", description: "查看测试会话已连接的 MCP 服务" },
        { name: "delegate", description: "向测试子会话委派工作", input: { hint: "工作内容" } },
      ],
    },
  });
const app = acp
  .agent({ name: "ACPAO Test Agent" })
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: process.env.MOCK_LOAD === "1" },
    _meta: process.env.MOCK_STEERING === "1" ? { steering: { supported: true } } : {},
    agentInfo: { name: "Deterministic test agent", version: "1.0" },
  }))
  .onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
    const sessionId = "mock-session";
    sessions.set(sessionId, { cancelled: false, running: false, mcp: params.mcpServers });
    await announceCommands(client, sessionId);
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
    sessions.set(params.sessionId, {
      cancelled: false,
      mcp: params.mcpServers,
    });
    await announceCommands(client, params.sessionId);
    return {};
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    const s = sessions.get(params.sessionId);
    if (s) s.cancelled = true;
  })
  .onRequest("_session/steering", (value) => value, async ({ params, client }) => {
    const s = sessions.get(params.sessionId);
    if (!s?.running) return { outcome: "promptRequired", reason: "noRunningTurn" };
    const text = params.prompt.map((p) => p.text).join("");
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n已收到引导：${text}\n` } },
    });
    return { outcome: "injected" };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const s = sessions.get(params.sessionId);
    s.cancelled = false;
    s.running = true;
    const text = params.prompt
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("");
    if (text === "/crash") process.exit(17);
    if (text.startsWith("/sleep "))
      await pause(Math.min(10000, Math.max(0, Number(text.slice(7)) || 0)));
    if (text.startsWith("/hang")) {
      await pause(60000);
      s.running = false;
      return { stopReason: "end_turn" };
    }
    if (text.startsWith("/permission")) {
      const r = await client.request(acp.methods.client.session.requestPermission, {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "t1",
          title: "测试：写入工作目录",
          kind: "edit",
          status: "pending",
        },
        options: [
          { optionId: "yes", name: "仅允许这一次", kind: "allow_once" },
          { optionId: "no", name: "拒绝", kind: "reject_once" },
        ],
      });
      if (r.outcome.outcome === "cancelled" || r.outcome.optionId === "no")
        return { stopReason: "cancelled" };
    }
    let output = `这是可控 ACP 测试 Agent 的真实协议输出，未调用模型。\n\n收到：${text}\n\n- [x] 建立独立 Session\n- [x] 完成流式响应\n\n配置真实 ACP Agent 后，即可开展实际工作。`;
    if (text.trim() === "/mcp")
      output = `MCP 服务：${s.mcp.map((server) => server.name).join("、") || "无"}`;
    if (text.startsWith("/delegate ")) {
      const transport = s.mcp[0];
      const mcp = new Client({ name: "mock-parent", version: "1.0" });
      await mcp.connect(
        new StdioClientTransport({
          command: transport.command,
          args: transport.args,
          env: Object.fromEntries(transport.env.map((e) => [e.name, e.value])),
        }),
      );
      try {
        const result = await mcp.callTool({
          name: "delegate",
          arguments: { agent: "mock", instruction: text.slice(10) },
        });
        const d = JSON.parse(result.content[0].text);
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `已委派，子会话 ${d.session}。\n` },
          },
        });
        const wait = await mcp.callTool({
          name: "wait",
          arguments: {
            sessions: [d.session],
            until: "terminal",
            timeoutMs: 25000,
          },
        });
        output = `测试委派结果（来自工具的真实响应）：\n\n\`\`\`json\n${wait.content[0].text}\n\`\`\``;
      } finally {
        await mcp.close();
      }
    }
    const chunks = output.match(/.{1,16}|\n/g) || [];
    for (const chunk of chunks) {
      if (s.cancelled) return { stopReason: "cancelled" };
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: chunk },
        },
      });
      await pause(text.startsWith("/slow") ? 60 : 5);
    }
    s.running = false;
    return { stopReason: s.cancelled ? "cancelled" : "end_turn" };
  });
app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
