import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createApp } from "../apps/server/src/app.js";
import { owner, adminToken, until, project } from "./helpers.js";
test("center restart retains history, marks unfinished work interrupted and supports advertised load", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "acpao-restart-")),
    options = {
      dataDir: resolve(root, "data"),
      root,
      projectRoot: project,
      adminToken,
      demo: true,
    };
  let c = await createApp(options);
  await c.app.listen({ host: "127.0.0.1", port: 0 });
  const host = c.store.host("local");
  host.agents[0]!.env.MOCK_LOAD = "1";
  c.store.put("host", "local", host);
  const s = await c.orchestration.create({ cwd: root }, owner);
  await c.orchestration.send({ session: s.id, text: "history survives" }, owner);
  await until(
    () => c.store.session(s.id).status,
    (v) => v === "completed",
  );
  await c.orchestration.send({ session: s.id, text: "/hang", requestId: "crash-running" }, owner);
  await c.app.close();
  c = await createApp(options);
  await c.app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await c.app.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(c.store.session(s.id).status, "interrupted");
  assert.equal(c.store.commands(s.id).find((x) => x.id === "crash-running")?.status, "interrupted");
  assert.match(
    c.store
      .messages(s.id)
      .map((x) => x.body)
      .join(""),
    /history survives/,
  );
  await c.orchestration.action(s.id, "resume", owner);
  assert.equal(c.store.session(s.id).status, "idle");
  await c.orchestration.send({ session: s.id, text: "after recovery" }, owner);
  await until(
    () => c.store.session(s.id).status,
    (v) => v === "completed",
  );
  assert.equal(c.store.messages(s.id).filter((m) => m.role === "user").length, 3);
});
