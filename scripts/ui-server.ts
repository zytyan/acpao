import { createApp } from "../apps/server/src/app.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
const root = await mkdtemp(resolve(tmpdir(), "acpao-ui-"));
await mkdir(resolve(root, "Projects", "Nested App"), { recursive: true });
const { app } = await createApp({
  dataDir: resolve(root, "data"),
  root,
  adminToken: "browser-test-admin-secret-123456",
  launchToken: "browser-test-launch-token-123456",
  demo: false,
  testFeatures: true,
});
await app.listen({ host: "127.0.0.1", port: 4317 });
let stop = false;
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    if (stop) return;
    stop = true;
    void app
      .close()
      .then(() => rm(root, { recursive: true, force: true }))
      .then(() => process.exit());
  });
