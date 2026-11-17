import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { Store, id, secret, hash } from "../../../packages/core/src/store.js";
import { Runtime } from "../../../packages/core/src/runtime.js";
import {
  Orchestrator,
  ToolSchemas,
  type ToolName,
} from "../../../packages/core/src/orchestrator.js";
import {
  AppError,
  AgentSchema,
  publicHost,
  type Host,
  type Session,
} from "../../../packages/core/src/types.js";
import { RemoteHub } from "./remote.js";
export interface AppOptions {
  dataDir?: string;
  root?: string;
  projectRoot?: string;
  executable?: boolean;
  adminToken?: string;
  launchToken?: string;
  demo?: boolean;
  publicUrl?: string;
  logger?: boolean;
  promptTimeoutMs?: number;
}
const descriptions: Record<ToolName, string> = {
  delegate:
    "将一件工作异步交给 Agent，返回独立会话。默认同一主机与目录；可选择 Git worktree 隔离。",
  send: "给会话发送指令；明确返回立即或排队。不支持 Steering 时返回错误，不静默降级。",
  wait: "用一个游标等待多个会话的进展或终态，最长 30 秒；摘要仅截取 Agent 实际输出。",
  sessions: "列出、查看、读取历史、创建、取消、关闭或按实际能力恢复会话。",
  hosts: "查询授权范围内的主机、可用 Agent 和能力。",
};
export async function createApp(options: AppOptions = {}) {
  const streams = new Set<ServerResponse>();
  const project = resolve(options.projectRoot ?? process.cwd()),
    root = resolve(options.root ?? process.env.ACPAO_ROOT ?? project),
    data = resolve(options.dataDir ?? ".data");
  mkdirSync(data, { recursive: true, mode: 0o700 });
  const tokenFile = resolve(data, "admin-token");
  let token = options.adminToken ?? process.env.ACPAO_ADMIN_TOKEN;
  if (!token) {
    if (existsSync(tokenFile)) token = readFileSync(tokenFile, "utf8").trim();
    else {
      token = secret();
      writeFileSync(tokenFile, token + "\n", { mode: 0o600, flag: "wx" });
    }
  }
  if (token.length < 16) throw new Error("ACPAO_ADMIN_TOKEN 必须至少 16 个字符");
  const publicUrl = options.publicUrl ?? process.env.ACPAO_PUBLIC_URL,
    app = Fastify({
      logger: options.logger
        ? {
            redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
            serializers: {
              req: (r) => ({
                method: r.method,
                url: r.url?.split("?")[0],
                id: r.id,
              }),
            },
          }
        : false,
      bodyLimit: 1024 * 1024,
      trustProxy: process.env.ACPAO_TRUST_PROXY === "1",
    });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const store = new Store(resolve(data, "center.sqlite"));
  const previousAdminHash = store.get<string>("setting", "admin-token-hash");
  if (previousAdminHash !== hash(token)) {
    store.revoke("admin", "owner");
    store.put("setting", "admin-token-hash", hash(token));
  }
  store.credential(token, { kind: "admin", id: "owner" });
  if (options.launchToken)
    store.credential(options.launchToken, { kind: "admin", id: "owner" }, Date.now() + 30 * 60000);
  if (!store.get<Host>("host", "local"))
    store.put("host", "local", {
      id: "local",
      name: "本机",
      kind: "local",
      status: "online",
      cwd: root,
      platform: process.platform,
      agents: options.demo
        ? [
            {
              id: "mock",
              name: "测试 Agent · 不调用模型",
              command: process.execPath,
              args: options.executable ? [] : [resolve(project, "scripts/mock-agent.mjs")],
              env: options.executable ? { ACPAO_SEA_MODE: "mock-agent" } : {},
            },
          ]
        : [],
    });
  else {
    const h = store.host("local");
    store.put("host", "local", { ...h, status: "online", cwd: root });
  }
  const remote = new RemoteHub(store, app.server);
  const agentToken = (s: Session) => {
    store.revoke("agent", s.id);
    const t = secret();
    store.credential(t, {
      kind: "agent",
      id: s.id,
      session: s.id,
      host: s.host,
    });
    return t;
  };
  const runtime = new Runtime(store, {
    host: "local",
    root,
    promptTimeoutMs: options.promptTimeoutMs,
    bridge: (s) => [
      {
        name: "acpao",
        command: process.execPath,
        args: options.executable ? [] : [resolve(project, "scripts/mcp-bridge.mjs")],
        env: [
          {
            name: "ACPAO_CENTER",
            value:
              publicUrl ??
              `http://127.0.0.1:${(app.server.address() as { port: number } | null)?.port ?? 4310}`,
          },
          { name: "ACPAO_TOKEN", value: agentToken(s) },
          ...(options.executable ? [{ name: "ACPAO_SEA_MODE", value: "mcp-bridge" }] : []),
        ],
      },
    ],
  });
  const orchestration = new Orchestrator(store, runtime, remote);
  const principal = (request: import("fastify").FastifyRequest) => {
    const auth = request.headers.authorization;
    const p = store.authenticate(
      auth?.startsWith("Bearer ") ? auth.slice(7) : (request.cookies.acpao ?? ""),
    );
    if (!p) throw new AppError("UNAUTHENTICATED", "请先登录", 401);
    return p;
  };
  const admin = (request: import("fastify").FastifyRequest) => {
    const p = principal(request);
    if (p.kind !== "admin") throw new AppError("FORBIDDEN", "需要人类管理员权限", 403);
    return p;
  };
  const isLocalRequest = (req: import("fastify").FastifyRequest) =>
    ["localhost", "127.0.0.1", "::1"].includes(req.hostname) &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip);
  const secureRequest = (req: import("fastify").FastifyRequest) => {
    if (req.protocol === "https") return;
    const host = req.hostname;
    if (
      publicUrl?.startsWith("https:") ||
      !["localhost", "127.0.0.1", "::1"].includes(host) ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip)
    )
      throw new AppError("TLS_REQUIRED", "设备配对和恢复必须通过 HTTPS", 403);
  };
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AppError)
      return reply
        .status(error.status)
        .send({ error: { code: error.code, message: error.message } });
    if (error instanceof z.ZodError)
      return reply.status(400).send({
        error: {
          code: "INVALID_INPUT",
          message: "输入格式不正确",
          fields: error.issues.map((e) => ({
            path: e.path.join("."),
            message: e.message,
          })),
        },
      });
    req.log.error({ code: "INTERNAL_ERROR", requestId: req.id }, "Request failed");
    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "操作失败，请检查配置或诊断记录。",
      },
    });
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Frame-Options", "DENY");
    if (req.url.startsWith("/api") || req.url.startsWith("/mcp"))
      reply.header("Cache-Control", "no-store");
    if (req.headers.origin) {
      const allowed = new Set([
        `http://${req.headers.host}`,
        `https://${req.headers.host}`,
        ...(publicUrl ? [new URL(publicUrl).origin] : []),
      ]);
      if (!allowed.has(req.headers.origin))
        throw new AppError("ORIGIN_FORBIDDEN", "来源不允许", 403);
    }
    if (
      (req.url.startsWith("/api/") &&
        !["/api/login", "/api/auth", "/api/gateway/pair"].includes(req.url.split("?")[0]!)) ||
      req.url.startsWith("/mcp")
    )
      principal(req);
  });
  app.get("/api/auth", async (req, reply) => {
    try {
      const authenticated = principal(req).kind === "admin";
      if (authenticated && isLocalRequest(req) && req.cookies.acpao)
        reply.setCookie("acpao", req.cookies.acpao, {
          httpOnly: true,
          sameSite: "strict",
          path: "/",
          maxAge: 10 * 365 * 86400,
        });
      return { authenticated };
    } catch {
      return { authenticated: false };
    }
  });
  app.post(
    "/api/login",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const v = z.object({ token: z.string().min(1).max(500) }).parse(req.body),
        p = store.authenticate(v.token);
      if (p?.kind !== "admin") throw new AppError("INVALID_CREDENTIAL", "登录密钥不正确", 401);
      const session = secret();
      const local = isLocalRequest(req);
      const maxAge = local ? 10 * 365 * 86400 : 30 * 86400;
      store.credential(
        session,
        { kind: "admin", id: "owner" },
        local ? undefined : Date.now() + maxAge * 1000,
      );
      if (options.launchToken && hash(v.token) === hash(options.launchToken))
        store.db.prepare("DELETE FROM credentials WHERE hash=?").run(hash(options.launchToken));
      reply.setCookie("acpao", session, {
        httpOnly: true,
        sameSite: "strict",
        secure: !local && !!publicUrl?.startsWith("https:"),
        path: "/",
        maxAge,
      });
      store.audit(p, "login", "workspace");
      return { ok: true };
    },
  );
  app.post("/api/logout", async (req, reply) => {
    admin(req);
    if (req.cookies.acpao)
      store.db.prepare("DELETE FROM credentials WHERE hash=?").run(hash(req.cookies.acpao));
    reply.clearCookie("acpao", { path: "/" });
    return { ok: true };
  });
  app.get("/api/config", async (req) => {
    admin(req);
    return {
      main: store.get<string>("setting", "main") ?? null,
      root,
      capabilities: {
        steering: false,
        sshBootstrap: false,
        processIsolation: "one-process-per-session",
      },
    };
  });
  app.post("/api/main", async (req) => {
    const p = admin(req),
      v = z.object({ session: z.string() }).parse(req.body);
    orchestration.authorize(p, store.session(v.session));
    store.put("setting", "main", v.session);
    store.audit(p, "workspace.main", v.session);
    store.event("", "main", {});
    return { ok: true };
  });
  app.get("/api/hosts", async (req) => {
    admin(req);
    return store.all<Host>("host").map(publicHost);
  });
  app.get("/api/hosts/local/agents/:agent", async (req) => {
    admin(req);
    const key = (req.params as { agent: string }).agent;
    const agent = store.host("local").agents.find((item) => item.id === key);
    if (!agent) throw new AppError("AGENT_NOT_FOUND", "Agent 配置不存在", 404);
    return agent;
  });
  app.get("/api/agents/detect", async (req) => {
    admin(req);
    const candidates = [
      { id: "codex", name: "Codex ACP", command: "codex-acp", args: [] },
      {
        id: "claude",
        name: "Claude Agent ACP",
        command: "claude-agent-acp",
        args: [],
      },
      { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--acp"] },
    ];
    const detected = [];
    for (const c of candidates) {
      for (const dir of (process.env.PATH ?? "").split(":")) {
        try {
          await access(resolve(dir, c.command), constants.X_OK);
          detected.push({ ...c, command: resolve(dir, c.command), env: {} });
          break;
        } catch {}
      }
    }
    return {
      agents: detected,
      fixture: {
        id: "mock",
        name: "测试 Agent · 不调用模型",
        command: process.execPath,
        args: options.executable ? [] : [resolve(project, "scripts/mock-agent.mjs")],
        env: options.executable ? { ACPAO_SEA_MODE: "mock-agent" } : {},
      },
    };
  });
  app.put("/api/hosts/local/agents", async (req) => {
    const p = admin(req),
      v = z.object({ agents: z.array(AgentSchema).max(30) }).parse(req.body),
      h = store.host("local");
    if (new Set(v.agents.map((a) => a.id)).size !== v.agents.length)
      throw new AppError("DUPLICATE_AGENT", "Agent ID 不可重复");
    store.put("host", "local", { ...h, agents: v.agents });
    store.audit(p, "host.configure", "local");
    store.event("", "hosts", {});
    return { ok: true };
  });
  app.post("/api/hosts/local/agent", async (req) => {
    const p = admin(req),
      v = z.object({ agent: AgentSchema }).parse(req.body),
      h = store.host("local");
    store.put("host", "local", {
      ...h,
      agents: [...h.agents.filter((a) => a.id !== v.agent.id), v.agent],
    });
    store.audit(p, "host.configure", "local");
    store.event("", "hosts", {});
    return { ok: true };
  });
  app.post("/api/hosts/pairings", async (req) => {
    const p = admin(req);
    secureRequest(req);
    const v = z.object({ name: z.string().min(1).max(100) }).parse(req.body),
      host = id("h"),
      code = secret();
    store.put("pairing", hash(code), {
      host,
      name: v.name,
      expires: Date.now() + 600000,
    });
    store.audit(p, "host.pairing", host);
    return {
      code,
      host,
      expiresAt: Date.now() + 600000,
      command:
        "在目标主机运行 npm run gateway -- --pair，并通过 ACPAO_CENTER、ACPAO_PAIR_CODE、ACPAO_ROOT 环境变量提供配置。",
    };
  });
  app.post(
    "/api/gateway/pair",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      secureRequest(req);
      const { code } = z.object({ code: z.string().min(16).max(200) }).parse(req.body),
        key = hash(code),
        pair = store.get<{ host: string; name: string; expires: number }>("pairing", key);
      if (!pair || pair.expires < Date.now())
        throw new AppError("PAIRING_EXPIRED", "配对码已失效", 401);
      const device = secret();
      store.transaction(() => {
        store.remove("pairing", key);
        store.put("host", pair.host, {
          id: pair.host,
          name: pair.name,
          kind: "remote",
          status: "offline",
          agents: [],
          cwd: "",
        } satisfies Host);
        store.credential(device, {
          kind: "device",
          id: pair.host,
          host: pair.host,
        });
        store.audit({ kind: "device", id: pair.host }, "host.paired", pair.host);
      });
      store.event("", "hosts", {});
      return { host: pair.host, token: device };
    },
  );
  app.post("/api/gateway/session-token", async (req) => {
    const p = principal(req);
    if (p.kind !== "device") throw new AppError("FORBIDDEN", "仅限设备身份", 403);
    const { session } = z.object({ session: z.string() }).parse(req.body),
      s = store.session(session);
    if (s.host !== p.host || store.host(s.host).status === "revoked")
      throw new AppError("FORBIDDEN", "会话不属于当前设备", 403);
    return { token: agentToken(s) };
  });
  app.post("/api/hosts/:host/revoke", async (req) => {
    const p = admin(req),
      h = store.host((req.params as { host: string }).host);
    if (h.kind === "local") throw new AppError("INVALID_HOST", "不能撤销本机");
    store.revoke("device", h.id);
    store.revoke("agent", h.id);
    store.put("host", h.id, { ...h, status: "revoked" });
    remote.revoke(h.id);
    store.audit(p, "host.revoke", h.id);
    store.event("", "hosts", {});
    return { ok: true };
  });
  app.post("/api/hosts/:host/rotate", async (req) => {
    const p = admin(req);
    secureRequest(req);
    const h = store.host((req.params as { host: string }).host);
    if (h.kind !== "remote" || h.status === "revoked")
      throw new AppError("INVALID_HOST", "请选择有效远程主机");
    const t = secret();
    store.revoke("device", h.id);
    store.revoke("agent", h.id);
    store.credential(t, { kind: "device", id: h.id, host: h.id });
    remote.revoke(h.id);
    store.audit(p, "host.rotate", h.id);
    return {
      host: h.id,
      token: t,
      warning:
        "旧凭据立即失效。此凭据仅恢复设备身份，不恢复中心数据库或 Agent 本地历史。请安全导入目标设备配置。",
    };
  });
  app.get("/api/sessions", async (req) => {
    const p = admin(req);
    return store.sessions().filter((s) => {
      orchestration.authorize(p, s);
      return true;
    });
  });
  app.post("/api/sessions", async (req) => orchestration.create(req.body, admin(req)));
  app.get("/api/sessions/:session", async (req) => {
    const p = admin(req),
      key = (req.params as { session: string }).session;
    orchestration.authorize(p, store.session(key));
    const query = z
      .object({ before: z.coerce.number().int().positive().optional() })
      .parse(req.query);
    return {
      session: store.session(key),
      messages: store.messages(key, query.before),
      approvals: store.approvals(key),
      delegations: store
        .sessions()
        .filter((s) => s.parent === key)
        .map((s) => orchestration.compact(s)),
      cursor: store.cursor(),
    };
  });
  app.post("/api/sessions/:session/send", async (req) =>
    orchestration.send(
      {
        ...(req.body as object),
        session: (req.params as { session: string }).session,
      },
      admin(req),
    ),
  );
  for (const action of ["cancel", "close", "resume"] as const)
    app.post(`/api/sessions/:session/${action}`, async (req) =>
      orchestration.action((req.params as { session: string }).session, action, admin(req)),
    );
  app.post("/api/approvals/:approval", async (req) => {
    const v = z.object({ option: z.string().optional() }).parse(req.body);
    return orchestration.approve(
      (req.params as { approval: string }).approval,
      v.option,
      admin(req),
    );
  });
  app.get("/api/sessions/:session/events", async (req) => {
    const p = admin(req),
      key = (req.params as { session: string }).session;
    orchestration.authorize(p, store.session(key));
    const v = z.object({ cursor: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const events = store.events(key, v.cursor, 100);
    return {
      events,
      cursor: events.at(-1)?.seq ?? v.cursor,
      latestCursor: store.cursor(),
      truncatedBefore: store.get<number>("setting", "pruned-through") ?? 0,
    };
  });
  app.get("/api/stream", async (req, reply) => {
    admin(req);
    const v = z.object({ cursor: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    let cursor = Math.max(v.cursor, Number(req.headers["last-event-id"] ?? 0) || 0);
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write("retry: 1500\n\n");
    const flush = () => {
      const next = store.cursor();
      if (next > cursor) {
        cursor = next;
        reply.raw.write(`id: ${cursor}\nevent: change\ndata: {"cursor":${cursor}}\n\n`);
      }
    };
    flush();
    store.changes.on("event", flush);
    const timer = setInterval(() => {
      try {
        const p = principal(req);
        if (p.kind !== "admin") {
          reply.raw.end();
          return;
        }
        reply.raw.write(": heartbeat\n\n");
      } catch {
        reply.raw.end();
      }
    }, 15000);
    req.raw.on("close", () => {
      streams.delete(reply.raw);
      clearInterval(timer);
      store.changes.off("event", flush);
    });
  });
  const toolList = () => ({
    tools: Object.entries(ToolSchemas).map(([name, schema]) => ({
      name,
      description: descriptions[name as ToolName],
      inputSchema: z.toJSONSchema(schema),
    })),
  });
  app.get("/api/tool-schema", async (req) => {
    const p = principal(req);
    if (p.kind === "device") throw new AppError("FORBIDDEN", "设备不可访问 Agent 工具", 403);
    return toolList();
  });
  app.post("/api/tools/:tool", async (req) => {
    const name = z
      .enum(["delegate", "send", "wait", "sessions", "hosts"])
      .parse((req.params as { tool: string }).tool);
    const abort = new AbortController();
    req.raw.on("aborted", () => abort.abort());
    return orchestration.tool(name, req.body, principal(req), abort.signal);
  });
  app.post("/mcp", async (req, reply) => {
    const p = principal(req);
    if (p.kind === "device") throw new AppError("FORBIDDEN", "设备不可调用 MCP", 403);
    const server = new McpServer({ name: "acpao", version: "0.1.0" });
    for (const name of Object.keys(ToolSchemas) as ToolName[])
      server.registerTool(
        name,
        { description: descriptions[name], inputSchema: ToolSchemas[name] },
        async (args: unknown, extra: { signal: AbortSignal }) => {
          try {
            const result = await orchestration.tool(name, args, p, extra.signal);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result) }],
            };
          } catch (e) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    code: e instanceof AppError ? e.code : "INVALID_INPUT",
                    message: e instanceof AppError ? e.message : "工具参数或执行失败",
                  }),
                },
              ],
            };
          }
        },
      );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });
  app.get("/api/diagnostics", async (req) => {
    admin(req);
    return {
      audit: store.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 100").all(),
      sessions: store
        .sessions()
        .filter((s) => ["error", "interrupted"].includes(s.status))
        .map((s) => ({ session: s.id, title: s.title, error: s.error })),
      retentionDays: 30,
    };
  });
  const web = resolve(
    process.env.ACPAO_EMBEDDED_WEB ?? project,
    process.env.ACPAO_EMBEDDED_WEB ? "" : "apps/web/dist",
  );
  if (existsSync(web)) {
    await app.register(staticFiles, { root: web, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url.startsWith("/mcp"))
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "接口不存在" } });
      return reply.sendFile("index.html");
    });
  }
  const prune = setInterval(() => store.prune(), 3600000);
  prune.unref();
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.end();
    streams.clear();
    await remote.close();
  });
  app.addHook("onClose", async () => {
    clearInterval(prune);
    await runtime.shutdown();
    store.close();
  });
  return { app, store, runtime, remote, orchestration, tokenFile };
}
