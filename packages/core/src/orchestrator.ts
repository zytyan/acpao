import { z } from "zod";
import { Store, id } from "./store.js";
import { Runtime } from "./runtime.js";
import {
  AppError,
  CreateSchema,
  SendSchema,
  publicHost,
  terminal,
  type Session,
  type AgentConfig,
  type Principal,
} from "./types.js";
export interface Remote {
  call(host: string, action: string, payload: unknown, commandId?: string): Promise<unknown>;
  listDirectories(host: string, payload: unknown): Promise<unknown>;
}
export const DirectorySchema = z.object({
  host: z.string().optional(),
  cwd: z.string().min(1).max(4096).optional(),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});
export const ToolSchemas = {
  delegate: z.object({
    agent: z.string().optional(),
    host: z.string().optional(),
    cwd: DirectorySchema.shape.cwd,
    instruction: z.string().min(1).max(100000),
    title: z.string().max(120).optional(),
    isolate: z.boolean().default(false),
    requestId: z.string().min(8).max(128).optional(),
  }),
  send: SendSchema,
  wait: z.object({
    sessions: z.array(z.string()).min(1).max(32),
    cursor: z.number().int().min(0).default(0),
    timeoutMs: z.number().int().min(0).max(30000).default(25000),
    until: z.enum(["change", "terminal"]).default("change"),
  }),
  sessions: z.object({
    action: z
      .enum(["list", "get", "history", "create", "cancel", "close", "resume"])
      .default("list"),
    session: z.string().optional(),
    cursor: z.number().int().min(0).default(0),
    host: z.string().optional(),
    agent: z.string().optional(),
    cwd: z.string().optional(),
    title: z.string().max(120).optional(),
  }),
  hosts: z.object({ host: z.string().optional() }),
  directories: DirectorySchema,
};
export type ToolName = keyof typeof ToolSchemas;
export class Orchestrator {
  constructor(
    readonly store: Store,
    readonly local: Runtime,
    readonly remote: Remote,
  ) {}
  authorize(p: Principal, s: Session) {
    if (p.kind === "admin") return;
    if (p.kind !== "agent" || !p.session || this.store.get<Session>("session", p.session)?.host !== p.host)
      throw new AppError("FORBIDDEN", "无权访问此会话", 403);
    let next: Session | undefined = s;
    for (let i = 0; i < 16 && next; i++) {
      if (next.id === p.session) return;
      next = next.parent ? this.store.get<Session>("session", next.parent) : undefined;
    }
    throw new AppError("FORBIDDEN", "仅可管理当前会话和委派的会话", 403);
  }
  private assertAgentOrigin(p: Principal) {
    if (p.kind === "device" || (p.kind === "agent" && (!p.session || this.store.get<Session>("session", p.session)?.host !== p.host)))
      throw new AppError("HOST_FORBIDDEN", "凭据不允许操作此主机", 403);
  }
  async directories(input: unknown, p: Principal) {
    this.assertAgentOrigin(p);
    const v = DirectorySchema.parse(input);
    const host = this.store.host(v.host ?? p.host ?? "local");
    if (host.status !== "online") throw new AppError("HOST_OFFLINE", "主机未连接", 409);
    if (p.kind === "admin") this.store.audit(p, "host.directories", host.id);
    return host.kind === "local"
      ? this.local.directories(v.cwd, v.offset)
      : this.remote.listDirectories(host.id, { cwd: v.cwd, offset: v.offset });
  }
  async changeDirectory(key: string, cwd: string, p: Principal) {
    const s = this.store.session(key);
    this.authorize(p, s);
    if (s.cwd === cwd) return s;
    const main = this.store.get<string>("setting", "main") === key;
    const result = await this.create({ host: s.host, agent: s.agent, title: s.title, cwd }, p, s.parent);
    if (main && this.store.get<string>("setting", "main") === key) {
      this.store.put("setting", "main", result.id);
      this.store.event("", "main", {});
    }
    this.store.event(key, "session.directory.changed", { session: result.id, cwd: result.cwd });
    return result;
  }
  async setModel(key: string, value: string, p: Principal) {
    const s = this.store.session(key);
    this.authorize(p, s);
    this.store.audit(p, "session.model.set", key);
    return s.host === "local" ? this.local.setModel(key, value)
      : this.remote.call(s.host, "model.set", { session: key, value });
  }
  async create(input: unknown, p: Principal, parent?: string, sessionId = id("s")) {
    const v = CreateSchema.parse(input);
    this.assertAgentOrigin(p);
    const h = this.store.host(v.host);
    if (h.status !== "online") throw new AppError("HOST_OFFLINE", "主机未连接", 409);
    if (p.kind === "agent") {
      if (
        this.store.sessions().filter((s) => s.parent === p.session && s.status !== "closed")
          .length >= 16
      )
        throw new AppError("DELEGATION_LIMIT", "当前会话委派数量已达上限", 429);
    }
    const config = h.agents.find((a) => a.id === v.agent) ?? (!v.agent ? h.agents[0] : undefined);
    if (!config) throw new AppError("AGENT_NOT_FOUND", "请先配置可用的 ACP Agent", 404);
    const s: Session = {
      id: sessionId,
      host: h.id,
      agent: config.id,
      cwd: v.cwd,
      title: v.title,
      status: "creating",
      parent: parent ?? (p.kind === "agent" ? p.session : undefined),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.store.put("session", s.id, s);
    this.store.put("session-agent", s.id, config);
    this.store.event(s.id, "session", s);
    this.store.audit(p, "session.create", s.id);
    try {
      if (h.kind === "local") await this.local.create(s, config, v.isolate);
      else
        await this.remote.call(h.id, "create", {
          session: s,
          agent: config,
          isolate: v.isolate,
        });
      if (v.main && p.kind === "admin") this.store.put("setting", "main", s.id);
      return this.store.session(s.id);
    } catch (e) {
      this.store.updateSession(s.id, {
        status: "error",
        error: e instanceof AppError ? e.message : "启动失败，请检查主机与 Agent。",
      });
      throw e;
    }
  }
  async send(input: unknown, p: Principal) {
    const v = SendSchema.parse(input),
      s = this.store.session(v.session);
    const source = p.kind === "agent" && p.session ? this.store.get<Session>("session", p.session) : undefined;
    // A delegated Agent may report to its direct parent without reading or managing that session.
    const reportingToParent = source && source.host === p.host && source.parent === s.id;
    if (!reportingToParent || v.mode === "steer")
      this.authorize(p, s);
    this.store.audit(p, "session.send", s.id);
    const mode = reportingToParent && v.mode === "auto" ? "queue" : v.mode;
    return s.host === "local"
      ? this.local.submit(s.id, v.text, mode, v.requestId)
      : this.remote.call(s.host, "send", { ...v, mode }, v.requestId);
  }
  async action(key: string, action: "cancel" | "close" | "resume", p: Principal) {
    const s = this.store.session(key);
    this.authorize(p, s);
    this.store.audit(p, `session.${action}`, key);
    if (action === "close") {
      const result = await (s.host === "local"
        ? this.local.close(key)
        : this.remote.call(s.host, action, { session: key }));
      this.store.revoke("agent", key);
      return result;
    }
    if (s.host !== "local") return this.remote.call(s.host, action, { session: key });
    if (action === "cancel") return this.local.cancel(key);
    const config =
      this.store.get<AgentConfig>("session-agent", s.id) ??
      this.store.host(s.host).agents.find((a) => a.id === s.agent);
    if (!config) throw new AppError("AGENT_NOT_FOUND", "Agent 配置已移除");
    return this.local.resume(key, config);
  }
  async approve(key: string, option: string | undefined, p: Principal) {
    if (p.kind !== "admin") throw new AppError("FORBIDDEN", "只有人类管理员可以审批", 403);
    const a = this.store.get<{ session: string }>("approval", key);
    if (!a) throw new AppError("NOT_FOUND", "审批不存在", 404);
    const s = this.store.session(a.session);
    this.store.audit(p, "approval.resolve", key);
    return s.host === "local"
      ? this.local.decide(key, option)
      : this.remote.call(s.host, "approve", { approval: key, option });
  }
  compact(s: Session) {
    const message = [...this.store.messages(s.id, undefined, 20)]
      .reverse()
      .find((m) => m.role === "assistant");
    return {
      session: s.id,
      title: s.title,
      agent: s.agent,
      host: s.host,
      cwd: s.cwd,
      status: s.status,
      ...(s.parent ? { parent: s.parent } : {}),
      ...(s.stopReason ? { stopReason: s.stopReason } : {}),
      ...(message ? { summary: message.body.slice(-1500) } : {}),
      ...(s.error ? { error: s.error } : {}),
    };
  }
  async tool(name: ToolName, input: unknown, p: Principal, signal?: AbortSignal): Promise<unknown> {
    if (p.kind === "device") throw new AppError("FORBIDDEN", "设备身份不可调用 Agent 工具", 403);
    if (
      p.kind === "agent" &&
      p.session &&
      ["closed", "interrupted", "error"].includes(this.store.session(p.session).status)
    )
      throw new AppError("SOURCE_INACTIVE", "来源会话已关闭或中断，委派权限暂不可用", 403);
    this.store.audit(p, `tool.${name}`, p.session ?? "workspace");
    switch (name) {
      case "hosts": {
        const v = ToolSchemas.hosts.parse(input);
        return this.store
          .all<import("./types.js").Host>("host")
          .filter((h) => (!v.host || h.id === v.host) && (p.kind === "admin" || h.status === "online"))
          .map((host) => p.kind === "admin" ? publicHost(host) : {
            id: host.id, name: host.name, status: host.status, cwd: host.cwd,
            agents: host.agents.map(({ id, name }) => ({ id, name })),
          });
      }
      case "send":
        return this.send(input, p);
      case "directories":
        return this.directories(input, p);
      case "delegate": {
        const v = ToolSchemas.delegate.parse(input),
          source = p.session ? this.store.session(p.session) : undefined,
          host = v.host ?? source?.host ?? "local";
        this.assertAgentOrigin(p);
        const requestKey = v.requestId ? `${p.id}:${v.requestId}` : undefined;
        const prior = requestKey
          ? this.store.get<{ session: string; fingerprint: string }>("delegate", requestKey)
          : undefined;
        const fingerprint = JSON.stringify(v);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw new AppError("IDEMPOTENCY_CONFLICT", "委派请求 ID 已用于其他指令", 409);
          const existing = this.store.get<Session>("session", prior.session);
          if (!existing)
            throw new AppError(
              "DELEGATION_INTERRUPTED",
              "此前委派在创建前中断；请使用新请求 ID 明确重试",
              409,
            );
          return { ...this.compact(existing), delivery: "previously_accepted" };
        }
        // Reserve before the first await: concurrent retries cannot create peers twice.
        const delegatedId = id("s");
        if (requestKey)
          this.store.put("delegate", requestKey, {
            session: delegatedId,
            fingerprint,
          });
        const s = await this.create(
          {
            host,
            agent: v.agent,
            cwd: v.cwd ?? (source?.host === host ? source.cwd : this.store.host(host).cwd),
            title: v.title ?? v.instruction.slice(0, 60),
            isolate: v.isolate,
          },
          p,
          undefined,
          delegatedId,
        );
        const result = await this.send(
          { session: s.id, text: v.instruction, requestId: `delegate-${s.id}` },
          p,
        );
        if (source)
          this.store.event(source.id, "delegated", {
            session: s.id,
            title: s.title,
          });
        return { ...this.compact(this.store.session(s.id)), delivery: result };
      }
      case "sessions": {
        const v = ToolSchemas.sessions.parse(input);
        if (v.action === "list")
          return this.store
            .sessions()
            .filter((s) => {
              try {
                this.authorize(p, s);
                return !v.host || v.host === s.host;
              } catch {
                return false;
              }
            })
            .slice(0, 100)
            .map((s) => this.compact(s));
        if (v.action === "create") {
          const host = v.host ?? p.host ?? "local";
          return this.compact(await this.create({ ...v, host, cwd: v.cwd ?? this.store.host(host).cwd }, p));
        }
        if (!v.session) throw new AppError("MISSING_SESSION", "此操作需要 session");
        const s = this.store.session(v.session);
        this.authorize(p, s);
        if (v.action === "get") return { ...this.compact(s), capabilities: s.capabilities };
        if (v.action === "history") {
          const events = this.store.events(s.id, v.cursor, 50);
          return {
            session: s.id,
            events,
            cursor: events.at(-1)?.seq ?? v.cursor,
            truncatedBefore: this.store.get<number>("setting", "pruned-through") ?? 0,
          };
        }
        return this.action(s.id, v.action, p);
      }
      case "wait": {
        const v = ToolSchemas.wait.parse(input);
        v.sessions.forEach((key) => this.authorize(p, this.store.session(key)));
        const deadline = Date.now() + v.timeoutMs;
        for (;;) {
          const current = v.sessions.map((key) => this.store.session(key));
          const events = v.sessions
            .flatMap((session) => this.store.events(session, v.cursor, 50))
            .sort((a, b) => a.seq - b.seq);
          const reached =
            v.until === "terminal"
              ? current.every((s) => terminal.has(s.status))
              : events.length > 0 || current.every((s) => terminal.has(s.status));
          if (reached || Date.now() >= deadline || signal?.aborted)
            return {
              sessions: current.map((s) => this.compact(s)),
              cursor: this.store.cursor(),
              timedOut: !reached,
              progress: events
                .filter((e) => ["queued", "approval", "delegated", "turn.end"].includes(e.kind))
                .slice(-12)
                .map((e) => ({
                  session: e.session,
                  kind: e.kind,
                  cursor: e.seq,
                })),
            };
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              this.store.changes.off("event", done);
              signal?.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, Math.min(1000, deadline - Date.now()));
            this.store.changes.once("event", done);
            signal?.addEventListener("abort", done, { once: true });
          });
        }
      }
    }
  }
}
