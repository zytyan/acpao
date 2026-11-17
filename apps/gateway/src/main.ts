import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chmodSync } from "node:fs";
import { z } from "zod";
import { resolve, dirname } from "node:path";
import { Store } from "../../../packages/core/src/store.js";
import { Gateway, GatewayConfig } from "./gateway.js";
const project = process.cwd(),
  file = resolve(process.env.ACPAO_GATEWAY_CONFIG ?? ".gateway/config.json");
if (process.argv.includes("--pair")) {
  if (existsSync(file))
    throw new Error("已有设备配置；导入恢复凭据请使用 --import-identity，而不是再次配对");
  const center = process.env.ACPAO_CENTER,
    code = process.env.ACPAO_PAIR_CODE;
  if (!center || !code) throw new Error("需要 ACPAO_CENTER 与 ACPAO_PAIR_CODE 环境变量");
  const url = new URL(center);
  if (
    url.protocol !== "https:" &&
    !(process.env.ACPAO_INSECURE_LOCAL === "1" && ["127.0.0.1", "localhost"].includes(url.hostname))
  )
    throw new Error("需要 HTTPS");
  const root = resolve(process.env.ACPAO_ROOT ?? project);
  const r = await fetch(new URL("/api/gateway/pair", center), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`配对失败 (${r.status})`);
  const identity = (await r.json()) as { host: string; token: string };
  const agents = process.env.ACPAO_AGENTS
    ? JSON.parse(readFileSync(process.env.ACPAO_AGENTS, "utf8"))
    : [];
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(
    file,
    JSON.stringify(
      {
        center,
        ...identity,
        root,
        agents,
        insecureLocal: process.env.ACPAO_INSECURE_LOCAL === "1",
      },
      null,
      2,
    ),
    { mode: 0o600, flag: "wx" },
  );
  console.log("配对成功，凭据已保存；请在配置文件中添加 ACP Agent。");
}
const importIndex = process.argv.indexOf("--import-identity");
if (importIndex >= 0) {
  const source = process.argv[importIndex + 1];
  if (!source) throw new Error("--import-identity 需要恢复凭据文件路径");
  const identity = z
    .object({ host: z.string(), token: z.string().min(16) })
    .parse(JSON.parse(readFileSync(resolve(source), "utf8")));
  const previous = GatewayConfig.parse(JSON.parse(readFileSync(file, "utf8")));
  if (previous.host !== identity.host) throw new Error("恢复凭据不属于当前配置中的设备");
  const temporary = file + ".new";
  writeFileSync(temporary, JSON.stringify({ ...previous, ...identity }, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
  console.log("设备身份已导入；配置和本地会话记录已保留。");
}
const config = GatewayConfig.parse(JSON.parse(readFileSync(file, "utf8"))),
  store = new Store(resolve(dirname(file), "gateway.sqlite")),
  gateway = new Gateway(store, config, project);
gateway.start();
console.log(
  JSON.stringify({
    level: "info",
    message: "Gateway started",
    host: config.host,
  }),
);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void gateway.stop().then(() => {
      store.close();
      process.exit(0);
    });
  });
