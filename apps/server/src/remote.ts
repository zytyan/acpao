import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { z } from "zod";
import { Store, id } from "../../../packages/core/src/store.js";
import {
  AgentSchema,
  AppError,
  type Host,
  type Session,
  type Event,
  type Approval,
  type Command,
} from "../../../packages/core/src/types.js";
import { readSlashCommands } from "../../../packages/core/src/slash-commands.js";
import type * as acp from "@agentclientprotocol/sdk";
const Hello = z.object({
  type: z.literal("hello"),
  agents: z.array(AgentSchema).max(30),
  cwd: z.string().max(4096),
  platform: z.string().max(100),
  manageAgents: z.boolean().optional(),
  arch: z.string().max(30).optional(),
  version: z.string().max(100).optional(),
  managed: z.boolean().optional(),
});
const EventSchema = z.object({
  seq: z.number().int().positive(),
  session: z.string(),
  kind: z.string().max(100),
  data: z.unknown(),
  createdAt: z.number(),
});
export class RemoteHub {
  readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
  });
  private peers = new Map<string, WebSocket>();
  private waiting = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
      promise?: Promise<unknown>;
      transientHost?: string;
    }
  >();
  private heartbeat: NodeJS.Timeout;
  constructor(
    readonly store: Store,
    server: Server,
  ) {
    for (const h of store
      .all<Host>("host")
      .filter((h) => h.kind === "remote" && h.status !== "revoked"))
      store.put("host", h.id, { ...h, status: "offline" });
    server.on("upgrade", (req, socket, head) => {
      const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "",
        p = store.authenticate(token);
      if (
        req.url !== "/gateway" ||
        p?.kind !== "device" ||
        store.host(p.host!).status === "revoked"
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connected(p.host!, ws));
    });
    this.heartbeat = setInterval(() => {
      for (const ws of this.peers.values()) {
        const alive = ws as WebSocket & { alive?: boolean };
        if (alive.alive === false) ws.terminate();
        else {
          alive.alive = false;
          ws.ping();
        }
      }
    }, 15000);
    this.heartbeat.unref();
  }
  private connected(host: string, ws: WebSocket) {
    this.peers.get(host)?.close(4000, "replaced");
    this.peers.set(host, ws);
    (ws as WebSocket & { alive?: boolean }).alive = true;
    ws.on("pong", () => {
      (ws as WebSocket & { alive?: boolean }).alive = true;
    });
    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (data.type === "hello") {
          const h = Hello.parse(data),
            current = this.store.host(host);
          this.store.put("host", host, {
            ...current,
            status: "online",
            error: undefined,
            agents: h.agents,
            cwd: h.cwd,
            platform: h.platform,
            manageAgents: h.manageAgents,
            gatewayArch: h.arch,
            gatewayVersion: h.version,
            gatewayManaged: h.managed,
            lastSeen: Date.now(),
          });
          ws.send(
            JSON.stringify({
              type: "sync",
              cursor: this.store.get<number>("gateway-cursor", host) ?? 0,
            }),
          );
          this.store.event("", "hosts", {});
          for (const command of this.store
            .all<{
              id: string;
              host: string;
              action: string;
              payload: unknown;
              status: string;
            }>("dispatch")
            .filter((c) => c.host === host && c.status === "pending"))
            ws.send(JSON.stringify({ type: "command", ...command }));
        } else if (data.type === "events") {
          const events = z.array(EventSchema).max(100).parse(data.events);
          for (const event of events) this.ingest(host, event as Event);
          ws.send(
            JSON.stringify({
              type: "ack",
              cursor: this.store.get<number>("gateway-cursor", host) ?? 0,
            }),
          );
        } else if (data.type === "result") {
          const key = z.string().parse(data.id),
            receipt = this.store.get<{ host: string }>("dispatch", key);
          const waiter = this.waiting.get(key);
          if (!receipt && key.startsWith("agent_") && !waiter) return; // Late management reply.
          if ((receipt?.host ?? waiter?.transientHost) !== host) throw new Error("foreign response");
          if (receipt) this.store.put("dispatch", key, {
            ...receipt,
            id: key,
            status: "done",
            result: data.result,
            error: data.error,
          });
          if (waiter) {
            clearTimeout(waiter.timer);
            this.waiting.delete(key);
            if (data.error)
              waiter.reject(
                new AppError(
                  String((data.error as { code: string }).code),
                  String((data.error as { message: string }).message),
                  409,
                ),
              );
            else waiter.resolve(data.result);
          }
        } else if (data.type === "sync_gap") {
          const current = this.store.host(host);
          this.store.put("host", host, {
            ...current,
            status: "offline",
            error: "中心游标早于网关保留的日志；请恢复匹配的中心备份后重启网关。",
          });
          this.store.event("", "hosts", {});
          ws.close(4009, "journal history gap");
        }
      } catch {
        ws.close(4002, "invalid gateway message");
      }
    });
    ws.on("close", () => {
      if (this.peers.get(host) !== ws) return;
      this.peers.delete(host);
      const current = this.store.host(host);
      if (current.status !== "revoked")
        this.store.put("host", host, { ...current, status: "offline" });
      this.store.event("", "hosts", {});
    });
  }
  private ingest(host: string, e: Event) {
    const cursor = this.store.get<number>("gateway-cursor", host) ?? 0;
    if (e.seq <= cursor) return;
    if (e.seq !== cursor + 1) throw new Error("event sequence gap");
    const s = e.session ? this.store.get<Session>("session", e.session) : undefined;
    if (e.session && s?.host !== host) throw new Error("foreign session event");
    this.store.transaction(() => {
      if (e.kind === "agents" && !e.session) {
        const agents = z.array(AgentSchema).max(30).parse(e.data);
        const current = this.store.host(host);
        this.store.put("host", host, { ...current, agents });
      }
      if (e.kind === "session" && s) {
        const update = e.data as Session;
        if (update.id !== s.id || update.host !== host) throw new Error("invalid session");
        this.store.put("session", s.id, { ...update, parent: s.parent });
      }
      if (e.kind === "queued" && s) {
        const d = e.data as { command: string; text: string };
        this.store.message(s.id, "user", d.command, d.text);
        this.store.command({
          id: d.command,
          session: s.id,
          text: d.text,
          status: "queued",
          createdAt: e.createdAt,
        });
      }
      if (["turn.start", "turn.end", "steered", "queue.cancelled"].includes(e.kind) && s) {
        const d = e.data as { command: string; status?: Command["status"]; stopReason?: string };
        const command = this.store.get<Command>("command", d.command);
        if (command?.session === s.id)
          this.store.command({
            ...command,
            status:
              e.kind === "turn.start"
                ? "running"
                : e.kind === "queue.cancelled"
                  ? (d.status ?? "cancelled")
                  : d.stopReason === "cancelled"
                    ? "cancelled"
                    : "completed",
          });
      }
      if (e.kind === "session.commands.reset" && s) this.store.remove("session-commands", s.id);
      if (e.kind === "acp.update" && s) {
        const { run, update } = e.data as {
          run: string;
          update: acp.SessionUpdate;
        };
        if (update.sessionUpdate === "available_commands_update")
          this.store.put("session-commands", s.id, readSlashCommands(update.availableCommands));
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
          this.store.message(s.id, "assistant", run, update.content.text, true);
        if (update.sessionUpdate === "plan")
          this.store.message(
            s.id,
            "assistant",
            `${run}:plan`,
            update.entries
              .map((x) => `- [${x.status === "completed" ? "x" : " "}] ${x.content}`)
              .join("\n"),
          );
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
          this.store.message(
            s.id,
            "tool",
            `${run}:${update.toolCallId}`,
            `${update.title ?? "工具执行"}\n${update.status ?? "进行中"}`,
          );
      }
      if (e.kind === "approval" && s) {
        const a = e.data as Approval;
        const existing = this.store.get<Approval>("approval", a.id);
        if (a.session !== s.id || (existing && existing.session !== s.id))
          throw new Error("foreign approval");
        this.store.put("approval", a.id, a);
      }
      if (e.kind === "diagnostic") {
        const detail = e.data as { level?: string; code?: string; message?: string; agent?: string };
        if (["info", "warning", "error"].includes(detail.level ?? "") && typeof detail.message === "string")
          this.store.diagnostic({ level: detail.level as "info" | "warning" | "error", source: "gateway",
            code: String(detail.code ?? "GATEWAY_EVENT").slice(0, 80), message: detail.message.slice(0, 8192),
            session: e.session || undefined, agent: detail.agent });
      }
      this.store.event(e.session, e.kind, e.data, host, e.seq);
      this.store.put("gateway-cursor", host, e.seq);
    });
  }
  manageAgent(host: string, action: "agent.get" | "agent.configure", payload: unknown) {
    const ws = this.peers.get(host);
    if (!ws || ws.readyState !== WebSocket.OPEN)
      throw new AppError("HOST_OFFLINE", "Gateway 未连接，请重连后再配置 Agent。", 409);
    if (!this.store.host(host).manageAgents)
      throw new AppError("GATEWAY_UPDATE_REQUIRED", "此 Gateway 版本需要升级后才能在界面配置 Agent。", 409);
    const key = id("agent");
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(key);
        reject(new AppError("AGENT_CONFIGURATION_UNCONFIRMED", "网关尚未确认，请刷新主机后检查是否保存。", 504));
      }, 30000);
      this.waiting.set(key, { resolve, reject, timer, transientHost: host });
      ws.send(JSON.stringify({ type: "command", id: key, action, payload }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.waiting.delete(key);
        reject(new AppError("HOST_OFFLINE", "无法向 Gateway 发送指令。", 409));
      });
    });
  }
  async call(host: string, action: string, payload: unknown, key = id("remote")): Promise<unknown> {
    const old = this.store.get<{
      host: string;
      action: string;
      payload: unknown;
      status: string;
      result?: unknown;
      error?: { code: string; message: string };
    }>("dispatch", key);
    if (old) {
      if (
        old.host !== host ||
        old.action !== action ||
        JSON.stringify(old.payload) !== JSON.stringify(payload)
      )
        throw new AppError("IDEMPOTENCY_CONFLICT", "指令 ID 冲突", 409);
      if (old.status === "done") {
        if (old.error) throw new AppError(old.error.code, old.error.message, 409);
        return old.result;
      }
    }
    const existing = this.waiting.get(key)?.promise;
    if (existing) return existing;
    const ws = this.peers.get(host);
    if (!ws || ws.readyState !== WebSocket.OPEN)
      throw new AppError("HOST_OFFLINE", "网关未连接；未提交此指令", 409);
    this.store.put("dispatch", key, {
      id: key,
      host,
      action,
      payload,
      status: "pending",
    });
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(key);
        reject(
          new AppError(
            "DELIVERY_UNCONFIRMED",
            "执行端尚未确认，请查看会话状态；重连后将使用同一指令 ID 对账。",
            504,
          ),
        );
      }, action === "gateway.upgrade" ? 110000 : 30000);
      this.waiting.set(key, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: "command", id: key, action, payload }));
    });
    this.waiting.get(key)!.promise = promise;
    return promise;
  }
  revoke(host: string) {
    this.peers.get(host)?.close(4003, "revoked");
    this.peers.delete(host);
  }
  async close() {
    clearInterval(this.heartbeat);
    for (const ws of this.peers.values()) ws.terminate();
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new AppError("SHUTDOWN", "中心已关闭", 503));
    }
    this.waiting.clear();
    this.peers.clear();
    this.wss.close();
  }
}
