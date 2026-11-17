import { createApp } from "./app.js";
import { openBrowser } from "./open-browser.js";
import { secret } from "../../../packages/core/src/store.js";
const host = process.env.HOST ?? "127.0.0.1",
  port = Number(process.env.PORT ?? 4310),
  launchToken = secret();
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) &&
  !process.env.ACPAO_PUBLIC_URL?.startsWith("https://")
)
  throw new Error("公开监听需要 ACPAO_PUBLIC_URL=https://… 并配置 TLS 反向代理");
let runningApp: Awaited<ReturnType<typeof createApp>>["app"] | undefined;
const { app } = await createApp({
  logger: process.env.ACPAO_LOG === "1",
  launchToken,
  projectRoot: process.env.ACPAO_EMBEDDED_WEB ? process.env.ACPAO_EMBEDDED_RUNTIME : undefined,
  root: process.env.ACPAO_ROOT ?? (process.env.ACPAO_EMBEDDED_WEB ? process.cwd() : undefined),
  executable: !!process.env.ACPAO_EMBEDDED_WEB,
  demo: process.env.ACPAO_DEMO === "1",
  dataDir: process.env.ACPAO_DATA_DIR,
  onRestart:
    process.env.ACPAO_SUPERVISED === "1"
      ? async () => {
          await runningApp?.close();
          process.exit(75);
        }
      : undefined,
});
runningApp = app;
await app.listen({ host, port });
const address = app.server.address();
const actualPort = address && typeof address !== "string" ? address.port : port;
const loopback = host === "::1" ? "[::1]" : host === "localhost" ? "localhost" : "127.0.0.1";
const base = process.env.ACPAO_PUBLIC_URL ?? `http://${loopback}:${actualPort}`;
const launchUrl = `${base.replace(/\/$/, "")}/#launch=${launchToken}`;
if (
  openBrowser(
    launchUrl,
    process.argv.includes("--no-browser") || process.argv.includes("--print-url"),
  )
)
  console.log("已在浏览器打开工作区。\n关闭此窗口将停止服务。");
else console.log(launchUrl);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.close();
  });
