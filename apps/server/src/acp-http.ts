import * as acp from "@agentclientprotocol/sdk";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Store, id } from "../../../packages/core/src/store.js";
import { Orchestrator } from "../../../packages/core/src/orchestrator.js";
import { AppError, type Principal } from "../../../packages/core/src/types.js";

const owner: Principal = { kind: "admin", id: "acp-http" };

export function registerAcpHttp(
  app: FastifyInstance,
  store: Store,
  orchestration: Orchestrator,
  authenticate: (request: FastifyRequest) => Principal,
) {
  const transport = new AcpServer({
    createAgent: () =>
      acp
        .agent({ name: "acpao" })
        .onRequest(acp.methods.agent.initialize, () => ({
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true },
          agentInfo: { name: "ACPAO Session Gateway", version: "0.1" },
        }))
        .onRequest(acp.methods.agent.session.new, async ({ params }) => {
          if (params.mcpServers.length)
            throw new AppError(
              "MCP_SERVERS_UNSUPPORTED",
              "外部 MCP Server 配置暂不支持通过 ACP HTTP 传入",
            );
          const session = await orchestration.create({ cwd: params.cwd, host: "local" }, owner);
          return { sessionId: session.id };
        })
        .onRequest(acp.methods.agent.session.load, async ({ params }) => {
          if (params.mcpServers.length)
            throw new AppError(
              "MCP_SERVERS_UNSUPPORTED",
              "外部 MCP Server 配置暂不支持通过 ACP HTTP 传入",
            );
          const session = store.session(params.sessionId);
          if (["interrupted", "error"].includes(session.status))
            await orchestration.action(session.id, "resume", owner);
          return {};
        })
        .onNotification(acp.methods.agent.session.cancel, async ({ params }) => {
          await orchestration.action(params.sessionId, "cancel", owner);
        })
        .onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal }) => {
          const session = store.session(params.sessionId);
          if (session.status === "closed") throw new AppError("SESSION_CLOSED", "会话已关闭", 409);
          const text = params.prompt
            .map((part) => {
              if (part.type !== "text")
                throw new AppError("CONTENT_UNSUPPORTED", "ACP HTTP 当前只支持文本 Prompt", 400);
              return part.text;
            })
            .join("");
          const command = id("acp_http");
          let cursor = store.cursor();
          const sent = await orchestration.send(
            { session: session.id, text, mode: "queue", requestId: command },
            owner,
          );
          if (!sent) throw new AppError("SEND_FAILED", "发送 Prompt 失败");
          const deadline = Date.now() + 10 * 60_000;
          for (;;) {
            const events = store.events(session.id, cursor, 200);
            for (const event of events) {
              cursor = event.seq;
              if (event.kind === "acp.update") {
                const detail = event.data as { run: string; update: acp.SessionUpdate };
                if (detail.run === command)
                  await client.notify(acp.methods.client.session.update, {
                    sessionId: session.id,
                    update: detail.update,
                  });
              }
              if (
                event.kind === "turn.end" &&
                (event.data as { command: string }).command === command
              )
                return {
                  stopReason: (event.data as { stopReason: acp.PromptResponse["stopReason"] })
                    .stopReason,
                };
              if (event.kind === "session") {
                const state = event.data as { status: string; error?: string };
                if (["error", "interrupted", "closed"].includes(state.status))
                  throw new AppError("SESSION_INTERRUPTED", state.error ?? "会话中断", 409);
              }
            }
            if (events.length === 200) continue;
            if (signal.aborted)
              throw new AppError("CLIENT_DISCONNECTED", "ACP HTTP 客户端已断开", 499);
            if (Date.now() > deadline)
              throw new AppError("PROMPT_TIMEOUT", "等待 Prompt 结果超时", 504);
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                store.changes.off("event", wake);
                resolve();
              }, 500);
              const wake = () => {
                clearTimeout(timer);
                store.changes.off("event", wake);
                resolve();
              };
              store.changes.on("event", wake);
            });
          }
        }),
  });

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/acp",
    handler: async (request, reply) => {
      authenticate(request);
      const url = `http://${request.headers.host ?? "localhost"}${request.url}`;
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers))
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const input = new Request(url, {
        method: request.method,
        headers,
        body: request.method === "POST" ? JSON.stringify(request.body) : undefined,
      });
      const result = await transport.handleRequest(input);
      reply.hijack();
      reply.raw.writeHead(result.status, Object.fromEntries(result.headers));
      reply.raw.flushHeaders();
      if (result.body) {
        const stream = Readable.fromWeb(
          result.body as unknown as import("node:stream/web").ReadableStream,
        );
        reply.raw.on("close", () => stream.destroy());
        stream.pipe(reply.raw);
      } else reply.raw.end();
    },
  });
  app.addHook("onClose", async () => {
    await transport.close();
  });
}
