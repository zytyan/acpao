import test from "node:test";
import assert from "node:assert/strict";
import { setup, until, owner, adminToken } from "./helpers.js";

test("supervised restart drains the local Prompt and rejects new writes", async (t) => {
  let restarted = false;
  const c = await setup(t, {
    onRestart: async () => {
      restarted = true;
    },
  });
  const session = await c.orchestration.create({ cwd: c.root, agent: "mock" }, owner);
  await c.orchestration.send({ session: session.id, text: "/sleep 800" }, owner);
  await until(
    () => c.store.session(session.id).status,
    (status) => status === "running",
  );
  const restart = await c.app.inject({
    method: "POST",
    url: "/api/system/restart",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {},
  });
  assert.equal(restart.statusCode, 200);
  assert.equal(restart.json().status, "draining");
  assert.equal(restarted, false);
  const blocked = await c.app.inject({
    method: "POST",
    url: `/api/sessions/${session.id}/send`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { text: "must wait" },
  });
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.json().error.code, "RESTARTING");
  await until(() => restarted, Boolean, 5000);
  assert.equal(c.store.session(session.id).status, "completed");
});
