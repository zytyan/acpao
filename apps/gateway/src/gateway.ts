import { WebSocket } from "ws";
import { z } from "zod";
import { resolve } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { Store, hash } from "../../../packages/core/src/store.js";
import { Runtime } from "../../../packages/core/src/runtime.js";
import {
  AgentSchema,
  AppError,
  type Session,
  type AgentConfig,
} from "../../../packages/core/src/types.js";
export const GatewayConfig = z.object({
  center: z.url(),
  token: z.string().min(16),
  host: z.string(),
  root: z.string(),
  agents: z.array(AgentSchema),
  insecureLocal: z.boolean().default(false),
});
export type GatewayOptions = z.infer<typeof GatewayConfig>;
export class Gateway {
  readonly runtime: Runtime;
  private socket?: WebSocket;
  private stopped = false;
  private retry?: NodeJS.Timeout;
  private tick?: NodeJS.Timeout;
  private cursor = 0;
  private sending = false;
  private ready = false;
  private backoff = 1000;
  private bridge = new Map<string, acp.McpServer[]>();
  private executing = new Map<string, Promise<unknown>>();
  constructor(
    readonly store: Store,
    readonly options: GatewayOptions,
    readonly projectRoot: string,
  ) {
    const url = new URL(options.center);
    if (
      url.protocol !== "https:" &&
      !(
        options.insecureLocal &&
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      )
    )
      throw new AppError("TLS_REQUIRED", "远程中心必须使用 HTTPS");
    this.runtime = new Runtime(store, {
      host: options.host,
      root: options.root,
      bridge: (s) => this.bridge.get(s.id) ?? [],
    });
    for (const receipt of store.all<{ id: string; status: string }>("receipt"))
      if (receipt.status === "executing")
        store.put("receipt", receipt.id, {
          ...receipt,
          status: "done",
          error: {
            code: "INTERRUPTED",
            message: "网关在执行此指令时重启；未重放指令。",
          },
        });
    store.changes.on("event", this.schedule);
  }
  start() {
    this.connect();
  }
  private schedule = () => {
    if (!this.tick)
      this.tick = setTimeout(() => {
        this.tick = undefined;
        this.flush();
      }, 25);
  };
  private connect() {
    if (this.stopped) return;
    const url = new URL("/gateway", this.options.center);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      maxPayload: 4 * 1024 * 1024,
    });
    this.socket = ws;
    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "hello",
          agents: this.options.agents.map((agent) => ({ ...agent, env: {} })),
          cwd: this.options.root,
          platform: process.platform,
        }),
      );
    });
    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (data.type === "sync" || data.type === "ack") {
          this.cursor = z.number().int().min(0).parse(data.cursor);
          const floor = this.store.get<number>("setting", "journal-floor") ?? 0;
          if (this.cursor < floor) {
            ws.send(JSON.stringify({ type: "sync_gap", floor }));
            return;
          }
          if (data.type === "ack") this.store.pruneJournal(this.cursor);
          this.ready = true;
          this.backoff = 1000;
          this.sending = false;
          this.flush();
        } else if (data.type === "command")
          void this.command(data).catch(() => ws.close(4002, "command failure"));
      } catch {
        ws.close(4002, "invalid message");
      }
    });
    ws.on("error", () => {});
    ws.on("close", (code) => {
      this.ready = false;
      this.sending = false;
      if (!this.stopped && ![4003, 4009].includes(code)) {
        this.retry = setTimeout(
          () => this.connect(),
          this.backoff + Math.random() * Math.min(this.backoff, 1000),
        );
        this.backoff = Math.min(this.backoff * 2, 30000);
      }
    });
  }
  private flush() {
    if (!this.ready || this.sending || this.socket?.readyState !== WebSocket.OPEN) return;
    const events = [];
    let bytes = 0;
    for (const event of this.store.events(undefined, this.cursor, 30)) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (bytes + size > 2 * 1024 * 1024 && events.length) break;
      events.push(event);
      bytes += size;
    }
    if (events.length) {
      this.sending = true;
      this.socket.send(JSON.stringify({ type: "events", events }));
    }
  }
  private async setupBridge(s: Session) {
    const r = await fetch(new URL("/api/gateway/session-token", this.options.center), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session: s.id }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new AppError("CREDENTIAL_FAILED", "无法获取会话委派权限");
    const { token } = (await r.json()) as { token: string };
    this.bridge.set(s.id, [
      {
        name: "acpao",
        command: process.execPath,
        args: [resolve(this.projectRoot, "scripts/mcp-bridge.mjs")],
        env: [
          { name: "ACPAO_CENTER", value: this.options.center },
          { name: "ACPAO_TOKEN", value: token },
        ],
      },
    ]);
  }
  private async command(data: Record<string, unknown>) {
    const key = z.string().parse(data.id),
      action = z
        .enum(["create", "send", "cancel", "close", "resume", "approve"])
        .parse(data.action),
      payload = data.payload as Record<string, unknown>,
      fingerprint = hash(JSON.stringify({ action, payload }));
    const old = this.store.get<{
      fingerprint: string;
      status: string;
      result?: unknown;
      error?: unknown;
    }>("receipt", key);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new AppError("IDEMPOTENCY_CONFLICT", "指令 ID 冲突");
      const running = this.executing.get(key);
      if (running) await running;
      const saved = this.store.get<typeof old>("receipt", key)!;
      this.sendResult(key, saved);
      return;
    }
    this.store.put("receipt", key, {
      id: key,
      fingerprint,
      status: "executing",
    });
    const work = (async () => {
      try {
        let result: unknown;
        if (action === "create") {
          const s = payload.session as Session;
          if (s.host !== this.options.host) throw new AppError("HOST_FORBIDDEN", "错误的目标主机");
          const agent = this.options.agents.find((a) => a.id === (payload.agent as AgentConfig).id);
          if (!agent) throw new AppError("AGENT_NOT_FOUND", "网关未配置此 Agent");
          await this.setupBridge(s);
          result = await this.runtime.create(s, agent, !!payload.isolate);
        } else if (action === "approve")
          result = this.runtime.decide(
            z.string().parse(payload.approval),
            z.string().optional().parse(payload.option),
          );
        else {
          const session = z.string().parse(payload.session);
          if (this.store.session(session).host !== this.options.host)
            throw new AppError("HOST_FORBIDDEN", "错误的会话");
          if (action === "send")
            result = this.runtime.submit(
              session,
              z.string().min(1).max(100000).parse(payload.text),
              z.enum(["auto", "queue", "steer", "immediate"]).default("auto").parse(payload.mode),
              key,
            );
          else if (action === "cancel") result = await this.runtime.cancel(session);
          else if (action === "close") result = await this.runtime.close(session);
          else {
            const s = this.store.session(session),
              agent = this.options.agents.find((a) => a.id === s.agent);
            if (!agent) throw new AppError("AGENT_NOT_FOUND", "Agent 不可用");
            await this.setupBridge(s);
            result = await this.runtime.resume(session, agent);
          }
        }
        this.store.put("receipt", key, {
          id: key,
          fingerprint,
          status: "done",
          result,
        });
      } catch (e) {
        this.store.put("receipt", key, {
          id: key,
          fingerprint,
          status: "done",
          error: {
            code: e instanceof AppError ? e.code : "EXECUTION_FAILED",
            message: e instanceof AppError ? e.message : "网关执行失败，请检查本机配置。",
          },
        });
      } finally {
        this.sendResult(key, this.store.get("receipt", key));
        this.schedule();
      }
    })();
    this.executing.set(key, work);
    try {
      await work;
    } finally {
      this.executing.delete(key);
    }
  }
  private sendResult(key: string, receipt: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify({ type: "result", id: key, ...(receipt as object) }));
  }
  disconnect() {
    this.socket?.terminate();
  }
  async stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.tick) clearTimeout(this.tick);
    this.store.changes.off("event", this.schedule);
    this.socket?.terminate();
    await Promise.allSettled([...this.executing.values()]);
    await this.runtime.shutdown();
  }
}
