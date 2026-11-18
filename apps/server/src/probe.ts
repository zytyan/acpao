import { Store, id } from "../../../packages/core/src/store.js";
import { findAgentExecutable } from "../../../packages/core/src/agent-spawn.js";
import { agentEnvironment } from "../../../packages/core/src/agent-command.js";
import { Runtime } from "../../../packages/core/src/runtime.js";
import { AppError, type AgentConfig, type Session } from "../../../packages/core/src/types.js";

export async function probeAgent(config: AgentConfig, root: string) {
  const executable = await findAgentExecutable(
    config.command,
    root,
    agentEnvironment(config.env, process.env, process.platform),
  );
  if (!executable)
    return {
      ok: false as const,
      stage: "executable",
      message: "找不到启动程序，或当前账户无执行权限",
      stderr: "",
    };
  const store = new Store(":memory:");
  let stderr = "";
  let stage = "launch";
  const runtime = new Runtime(store, {
    host: "local",
    root,
    onStderr: (_, chunk) => {
      stderr = (stderr + chunk).slice(-65536);
    },
    onStage: (_, next) => {
      stage = next;
    },
  });
  const now = Date.now();
  const session: Session = {
    id: id("probe"),
    host: "local",
    agent: config.id,
    cwd: root,
    title: "连接测试",
    status: "creating",
    createdAt: now,
    updatedAt: now,
  };
  try {
    await runtime.create(session, { ...config, command: executable });
    return { ok: true as const, stage: "session", message: "程序已启动，ACP 会话已创建" };
  } catch (error) {
    return {
      ok: false as const,
      stage,
      message: error instanceof AppError || error instanceof Error ? error.message : "ACP 连接失败",
      stderr,
    };
  } finally {
    await runtime.shutdown();
    store.close();
  }
}
