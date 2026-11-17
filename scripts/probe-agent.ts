// Optional, explicit real-agent compatibility probe; never used by the test suite.
import { createApp } from "../apps/server/src/app.js";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
const command = process.env.ACPAO_PROBE_COMMAND;
if (!command) throw new Error("Set ACPAO_PROBE_COMMAND and optional ACPAO_PROBE_ARGS JSON");
const root = await mkdtemp(resolve(tmpdir(), "acpao-real-probe-"));
const c = await createApp({
  dataDir: resolve(root, "data"),
  root,
  adminToken: "local-probe-not-a-production-secret",
});
await c.app.listen({ host: "127.0.0.1", port: 0 });
const h = c.store.host("local");
h.agents = [
  {
    id: "real",
    name: "Real ACP compatibility probe",
    command,
    args: JSON.parse(process.env.ACPAO_PROBE_ARGS ?? "[]"),
    env: JSON.parse(process.env.ACPAO_PROBE_ENV ?? "{}"),
  },
];
c.store.put("host", "local", h);
try {
  const s = await c.orchestration.create(
    { cwd: root, agent: "real" },
    { kind: "admin", id: "owner" },
  );
  console.log(
    JSON.stringify({
      status: s.status,
      capabilities: s.capabilities,
      hasAcpId: !!s.acpId,
    }),
  );
} catch (e) {
  console.log(
    JSON.stringify({
      status: "failed",
      message: e instanceof Error ? e.message : "probe failed",
    }),
  );
  process.exitCode = 1;
} finally {
  await c.app.close();
  await rm(root, { recursive: true, force: true });
}
