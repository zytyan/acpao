import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { realpath, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Store, id } from "./store.js";
import { agentEnvironment } from "./agent-command.js";
import { AppError, type Session, type AgentConfig, type Command, type Approval } from "./types.js";
interface Slot {
  process: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
  active?: string;
  ready: boolean;
  stopping: boolean;
  cancelled: boolean;
}
export interface RuntimeOptions {
  host: string;
  root: string;
  maxConcurrent?: number;
  promptTimeoutMs?: number;
  cancelGraceMs?: number;
  bridge?: (s: Session) => acp.McpServer[];
}
export class Runtime {
  private slots = new Map<string, Slot>();
  private pending = new Map<
    string,
    {
      session: string;
      resolve: (r: acp.RequestPermissionResponse) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private stopping = false;
  constructor(
    readonly store: Store,
    readonly options: RuntimeOptions,
  ) {
    for (const s of store
      .sessions()
      .filter((s) => s.host === options.host && s.status !== "closed"))
      store.updateSession(s.id, {
        status: "interrupted",
        processId: undefined,
        error: "执行端已重启；未自动重放正在执行的指令。",
      });
    for (const c of store.commands().filter((c) => ["running", "queued"].includes(c.status)))
      store.command({ ...c, status: "interrupted" });
    for (const a of store.approvals()) store.approval({ ...a, status: "cancelled" });
  }
  async directory(cwd: string, isolate = false) {
    if (!isAbsolute(cwd)) throw new AppError("INVALID_DIRECTORY", "工作目录必须是绝对路径");
    const root = await realpath(this.options.root),
      target = await realpath(cwd).catch(() => {
        throw new AppError("DIRECTORY_NOT_FOUND", "工作目录不存在");
      });
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new AppError("DIRECTORY_FORBIDDEN", "目录超出主机允许的工作根目录", 403);
    if (!(await stat(target)).isDirectory())
      throw new AppError("INVALID_DIRECTORY", "工作目录不是文件夹");
    if (!isolate) return target;
    const worktree = resolve(target, ".acpao-worktrees", id("work"));
    await promisify(execFile)(
      "git",
      ["-C", target, "worktree", "add", "--detach", worktree, "HEAD"],
      { timeout: 30000 },
    );
    return worktree;
  }
  async create(s: Session, config: AgentConfig, isolate = false) {
    const cwd = await this.directory(s.cwd, isolate);
    this.store.put("session", s.id, { ...s, cwd });
    this.store.event(s.id, "session", { ...s, cwd });
    await this.connect(s.id, config, false);
    return this.store.session(s.id);
  }
  async resume(key: string, config: AgentConfig) {
    const s = this.store.session(key);
    if (this.slots.has(key)) throw new AppError("SESSION_ACTIVE", "会话进程仍在运行");
    if (!s.acpId || !s.capabilities?.load)
      throw new AppError("RESTORE_UNSUPPORTED", "此 Agent 未声明支持 session/load");
    await this.directory(s.cwd);
    await this.connect(key, config, true);
    return this.store.session(key);
  }
  private async connect(key: string, config: AgentConfig, restore: boolean) {
    if (this.stopping) throw new AppError("SHUTTING_DOWN", "执行端正在关闭", 503);
    if (this.slots.size >= 32)
      throw new AppError(
        "PROCESS_LIMIT",
        "本机最多同时保持 32 个 Agent 进程，请关闭不用的会话",
        429,
      );
    const s = this.store.session(key);
    this.store.updateSession(key, { status: "creating", error: undefined });
    const child = spawn(config.command, config.args, {
      cwd: s.cwd,
      env: agentEnvironment(config.env, process.env, process.platform),
      stdio: "pipe",
      detached: process.platform !== "win32",
    });
    // Drain stderr without copying possibly sensitive agent diagnostics into logs.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    const connection = acp
      .client({ name: "acpao" })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.sessionId === this.store.session(key).acpId || !this.store.session(key).acpId)
          this.update(key, params.update);
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) =>
        this.permission(key, params),
      )
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
          { maxMessageBytes: 1024 * 1024 },
        ),
      );
    const slot: Slot = {
      process: child,
      connection,
      ready: false,
      stopping: false,
      cancelled: false,
    };
    this.slots.set(key, slot);
    const lost = () => {
      if (slot.stopping) return;
      slot.stopping = true;
      this.resolvePermissions(key);
      this.slots.delete(key);
      connection.close();
      this.kill(slot);
      const current = this.store.session(key);
      if (current.status !== "closed")
        this.store.updateSession(key, {
          status: "interrupted",
          processId: undefined,
          error: "Agent 进程或 ACP 连接已退出，请手动恢复或新建会话。",
        });
      if (slot.active) {
        const c = this.store.get<Command>("command", slot.active);
        if (c?.status === "running") this.store.command({ ...c, status: "interrupted" });
      }
      this.discardQueue(key);
      this.pump();
    };
    child.once("error", lost);
    child.once("exit", lost);
    void connection.closed.then(lost).catch(lost);
    try {
      const init = await connection.agent.request(
        acp.methods.agent.initialize,
        {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "acpao", version: "0.1.0" },
        },
        {
          cancellationSignal: AbortSignal.timeout(20000),
          stopWaitingOnCancel: true,
        },
      );
      if (init.protocolVersion !== acp.PROTOCOL_VERSION)
        throw new AppError("PROTOCOL_MISMATCH", "ACP 协议版本不兼容");
      this.store.updateSession(key, {
        capabilities: {
          load: !!init.agentCapabilities?.loadSession,
          steering: false,
        },
        processId: child.pid,
      });
      const mcpServers = this.options.bridge?.(this.store.session(key)) ?? [];
      if (restore) {
        if (!init.agentCapabilities?.loadSession)
          throw new AppError("RESTORE_UNSUPPORTED", "Agent 当前不支持历史恢复");
        await connection.agent.request(
          acp.methods.agent.session.load,
          { sessionId: s.acpId!, cwd: s.cwd, mcpServers },
          {
            cancellationSignal: AbortSignal.timeout(20000),
            stopWaitingOnCancel: true,
          },
        );
      } else {
        const result = await connection.agent.request(
          acp.methods.agent.session.new,
          { cwd: s.cwd, mcpServers },
          {
            cancellationSignal: AbortSignal.timeout(20000),
            stopWaitingOnCancel: true,
          },
        );
        this.store.updateSession(key, { acpId: result.sessionId });
      }
      if (slot.stopping) throw new AppError("AGENT_EXITED", "Agent 初始化时退出");
      slot.ready = true;
      this.store.updateSession(key, { status: "idle", error: undefined });
      this.pump();
    } catch (e) {
      this.stopSlot(key);
      this.store.updateSession(key, {
        status: "error",
        processId: undefined,
        error:
          e instanceof AppError ? e.message : "ACP 初始化失败，请检查启动命令及 Agent 登录状态。",
      });
      throw e;
    }
  }
  private update(key: string, update: acp.SessionUpdate) {
    const slot = this.slots.get(key);
    if (slot?.stopping) return;
    const run = slot?.active ?? "history";
    this.store.transaction(() => {
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
        this.store.message(key, "assistant", run, update.content.text, true);
      if (update.sessionUpdate === "tool_call")
        this.store.message(
          key,
          "tool",
          `${run}:${update.toolCallId}`,
          `${update.title}\n${update.status}`,
        );
      if (update.sessionUpdate === "tool_call_update")
        this.store.message(
          key,
          "tool",
          `${run}:${update.toolCallId}`,
          `${update.title ?? "工具执行"}\n${update.status ?? "进行中"}`,
        );
      if (update.sessionUpdate === "plan")
        this.store.message(
          key,
          "assistant",
          `${run}:plan`,
          update.entries
            .map((e) => `- [${e.status === "completed" ? "x" : " "}] ${e.content}`)
            .join("\n"),
        );
      this.store.event(key, "acp.update", { run, update });
    });
  }
  submit(key: string, text: string, mode = "auto", requestId = id("cmd")) {
    const existing = this.store.get<Command>("command", requestId);
    if (existing) {
      if (existing.session !== key || existing.text !== text)
        throw new AppError("IDEMPOTENCY_CONFLICT", "相同请求 ID 的指令内容不同", 409);
      return {
        session: key,
        command: requestId,
        delivery: "duplicate",
        status: existing.status,
      };
    }
    const s = this.store.session(key),
      slot = this.slots.get(key);
    if (!slot?.ready || ["closed", "error", "interrupted"].includes(s.status))
      throw new AppError("SESSION_UNAVAILABLE", "会话当前不可用，请恢复或创建会话", 409);
    if (mode === "steer")
      throw new AppError(
        "STEERING_UNSUPPORTED",
        "此稳定 ACP 适配器不支持 Steering；可显式选择 queue",
        409,
      );
    const busy = !!slot.active || this.store.commands(key, "queued").length > 0;
    if (mode === "immediate" && (busy || this.runningCount() >= (this.options.maxConcurrent ?? 4)))
      throw new AppError("SESSION_BUSY", "当前无法立即执行", 409);
    if (this.store.commands(key, "queued").length >= 100)
      throw new AppError("QUEUE_FULL", "会话队列已满", 429);
    this.store.transaction(() => {
      this.store.command({
        id: requestId,
        session: key,
        text,
        status: "queued",
        createdAt: Date.now(),
      });
      this.store.message(key, "user", requestId, text);
      if (s.title === "新的工作")
        this.store.put("session", key, {
          ...s,
          title: text.slice(0, 60),
          updatedAt: Date.now(),
        });
      this.store.event(key, "queued", { command: requestId, text });
    });
    const immediate = !busy && this.runningCount() < (this.options.maxConcurrent ?? 4);
    this.pump();
    return {
      session: key,
      command: requestId,
      delivery: immediate ? "immediate" : "queued",
      status: this.store.session(key).status,
    };
  }
  private runningCount() {
    return [...this.slots.values()].filter((s) => s.active).length;
  }
  private pump() {
    if (this.stopping) return;
    for (const c of this.store.commands(undefined, "queued")) {
      if (this.runningCount() >= (this.options.maxConcurrent ?? 4)) break;
      const slot = this.slots.get(c.session);
      if (slot?.ready && !slot.active && !slot.stopping) {
        slot.active = c.id;
        slot.cancelled = false;
        this.store.command({ ...c, status: "running" });
        this.store.updateSession(c.session, {
          status: "running",
          error: undefined,
          stopReason: undefined,
        });
        void this.run(c, slot);
      }
    }
  }
  private async run(c: Command, slot: Slot) {
    const timeout = setTimeout(() => {
      if (slot.active !== c.id) return;
      this.store.command({ ...c, status: "failed" });
      this.stopSlot(c.session);
      this.discardQueue(c.session);
      this.store.updateSession(c.session, {
        status: "interrupted",
        processId: undefined,
        error: "执行超时；进程已终止，指令不会自动重试。",
      });
      this.pump();
    }, this.options.promptTimeoutMs ?? 600000);
    try {
      const result = await slot.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.store.session(c.session).acpId!,
        prompt: [{ type: "text", text: c.text }],
      });
      if (slot.stopping) return;
      const cancelled = result.stopReason === "cancelled" || slot.cancelled;
      this.store.command({
        ...c,
        status: cancelled ? "cancelled" : "completed",
      });
      this.store.updateSession(c.session, {
        status: cancelled ? "cancelled" : "completed",
        stopReason: result.stopReason,
      });
      this.store.event(c.session, "turn.end", {
        command: c.id,
        stopReason: result.stopReason,
      });
    } catch {
      if (!slot.stopping) {
        this.store.command({ ...c, status: "failed" });
        this.store.updateSession(c.session, {
          status: "error",
          error: "ACP Prompt 失败；可查看诊断或发送新的指令。",
        });
        this.discardQueue(c.session);
      }
    } finally {
      clearTimeout(timeout);
      this.resolvePermissions(c.session);
      slot.active = undefined;
      this.pump();
    }
  }
  private permission(
    key: string,
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const slot = this.slots.get(key);
    if (!slot?.active || slot.cancelled || request.sessionId !== this.store.session(key).acpId)
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const a: Approval = {
      id: id("approval"),
      session: key,
      request,
      status: "pending",
      createdAt: Date.now(),
    };
    this.store.approval(a);
    this.store.updateSession(key, { status: "waiting_permission" });
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.decide(a.id, undefined), 300000);
      this.pending.set(a.id, { session: key, resolve, timer });
    });
  }
  decide(key: string, option?: string) {
    const p = this.pending.get(key),
      a = this.store.get<Approval>("approval", key);
    if (!p || !a) throw new AppError("APPROVAL_EXPIRED", "审批已失效", 409);
    const req = a.request as acp.RequestPermissionRequest;
    const selected = req.options.find((o) => o.optionId === option);
    if (option && !selected) throw new AppError("INVALID_OPTION", "审批选项不存在");
    clearTimeout(p.timer);
    this.pending.delete(key);
    this.store.approval({
      ...a,
      status: !selected ? "cancelled" : selected.kind.startsWith("allow") ? "approved" : "denied",
    });
    if (
      this.slots.get(p.session)?.active &&
      !this.slots.get(p.session)?.cancelled &&
      !this.slots.get(p.session)?.stopping &&
      this.store.session(p.session).status === "waiting_permission"
    )
      this.store.updateSession(p.session, { status: "running" });
    p.resolve({
      outcome: selected
        ? { outcome: "selected", optionId: selected.optionId }
        : { outcome: "cancelled" },
    });
    return { status: "resolved" };
  }
  private resolvePermissions(key: string) {
    for (const [a, p] of this.pending) if (p.session === key) this.decide(a);
  }
  private discardQueue(key: string) {
    for (const c of this.store.commands(key, "queued"))
      this.store.command({ ...c, status: "cancelled" });
  }
  async cancel(key: string) {
    const slot = this.slots.get(key);
    this.discardQueue(key);
    if (!slot?.active) return { status: this.store.session(key).status };
    slot.cancelled = true;
    const active = slot.active;
    this.store.updateSession(key, { status: "cancelling" });
    this.resolvePermissions(key);
    await slot.connection.agent
      .notify(acp.methods.agent.session.cancel, {
        sessionId: this.store.session(key).acpId!,
      })
      .catch(() => {});
    const timer = setTimeout(() => {
      if (slot.active === active && !slot.stopping) {
        const c = this.store.get<Command>("command", active)!;
        this.store.command({ ...c, status: "cancelled" });
        this.stopSlot(key);
        this.store.updateSession(key, {
          status: "interrupted",
          processId: undefined,
          error: "Agent 未及时确认取消，已终止进程。",
        });
        this.pump();
      }
    }, this.options.cancelGraceMs ?? 3000);
    timer.unref();
    return { status: "cancelling" };
  }
  private kill(slot: Slot) {
    try {
      if (slot.process.pid && process.platform !== "win32")
        process.kill(-slot.process.pid, "SIGTERM");
      else slot.process.kill("SIGTERM");
    } catch {}
    const t = setTimeout(() => {
      try {
        if (slot.process.pid && process.platform !== "win32")
          process.kill(-slot.process.pid, "SIGKILL");
        else slot.process.kill("SIGKILL");
      } catch {}
    }, 1000);
    t.unref();
  }
  private stopSlot(key: string) {
    const slot = this.slots.get(key);
    if (!slot) return;
    slot.stopping = true;
    this.resolvePermissions(key);
    slot.connection.close();
    this.kill(slot);
    this.slots.delete(key);
  }
  async close(key: string) {
    await this.cancel(key);
    const active = this.slots.get(key)?.active;
    if (active) {
      const command = this.store.get<Command>("command", active);
      if (command?.status === "running") this.store.command({ ...command, status: "cancelled" });
    }
    this.stopSlot(key);
    this.store.updateSession(key, { status: "closed", processId: undefined });
    return { status: "closed" };
  }
  async shutdown() {
    this.stopping = true;
    for (const key of [...this.slots.keys()]) {
      const slot = this.slots.get(key)!;
      if (slot.active) {
        const c = this.store.get<Command>("command", slot.active);
        if (c) this.store.command({ ...c, status: "interrupted" });
      }
      this.discardQueue(key);
      this.stopSlot(key);
      if (this.store.session(key).status !== "closed")
        this.store.updateSession(key, {
          status: "interrupted",
          processId: undefined,
          error: "执行端已停止；需要手动恢复。",
        });
    }
  }
}
