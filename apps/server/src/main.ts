import { createApp } from "./app.js";
const host = process.env.HOST ?? "127.0.0.1",
  port = Number(process.env.PORT ?? 4310);
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) &&
  !process.env.ACPAO_PUBLIC_URL?.startsWith("https://")
)
  throw new Error("公开监听需要 ACPAO_PUBLIC_URL=https://… 并配置 TLS 反向代理");
const { app, tokenFile } = await createApp({
  logger: true,
  demo: process.env.ACPAO_DEMO === "1",
  dataDir: process.env.ACPAO_DATA_DIR,
});
await app.listen({ host, port });
console.log(`ACPAO: http://${host}:${port} · 登录密钥文件：${tokenFile}`);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.close();
  });
