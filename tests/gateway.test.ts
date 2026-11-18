import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Gateway } from "../apps/gateway/src/gateway.js";
import { Store } from "../packages/core/src/store.js";
import { setup, until, owner, project, adminToken } from "./helpers.js";
import type { Host, Command } from "../packages/core/src/types.js";
test("Gateway pairing, offline execution, event replay, deduplication and restart reconciliation", async (t) => {
  let cleanupGateway: (() => Promise<void>) | undefined;
  t.after(() => cleanupGateway?.());
  const c = await setup(t);
  const pairing = await c.app.inject({
    method: "POST",
    url: "/api/hosts/pairings",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { name: "remote test" },
  });
  assert.equal(pairing.statusCode, 200);
  const pair = pairing.json() as { code: string; host: string };
  const r = await fetch(c.url + "/api/gateway/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: pair.code }),
  });
  assert.equal(r.status, 200);
  const identity = (await r.json()) as { host: string; token: string };
  const again = await c.app.inject({
    method: "POST",
    url: "/api/gateway/pair",
    payload: { code: pair.code },
  });
  assert.equal(again.statusCode, 401);
  const path = resolve(c.root, "remote/gateway.sqlite");
  let db = new Store(path);
  const options = {
    center: c.url,
    ...identity,
    root: c.root,
    insecureLocal: true,
    agents: [
      {
        id: "mock",
        name: "Remote mock",
        command: process.execPath,
        args: [resolve(project, "scripts/mock-agent.mjs")],
        env: { MOCK_LOAD: "1" },
      },
    ],
  };
  let gateway = new Gateway(db, options, project);
  cleanupGateway = async () => {
    try {
      await gateway.stop();
    } finally {
      db.close();
    }
  };
  gateway.start();
  await until(
    () => c.store.host(identity.host),
    (h) => h.status === "online",
  );
  const s = await c.orchestration.create(
    { host: identity.host, cwd: c.root, agent: "mock", title: "远程执行" },
    owner,
  );
  await until(
    () => c.store.session(s.id).status,
    (v) => v === "idle",
  );
  const command = "remote-command-unique";
  const payload = { session: s.id, text: "/slow remote offline work", requestId: command };
  const [first, duplicate] = await Promise.all([
    c.orchestration.send(payload, owner),
    c.orchestration.send(payload, owner),
  ]);
  assert.deepEqual(first, duplicate);
  gateway.disconnect();
  await until(
    () => c.store.host(identity.host).status,
    (v) => v === "offline",
  );
  assert.equal(db.session(s.id).status, "running");
  await until(
    () => db.session(s.id).status,
    (v) => v === "completed",
  );
  await until(
    () => c.store.host(identity.host).status,
    (v) => v === "online",
  );
  await until(
    () => c.store.session(s.id).status,
    (v) => v === "completed",
  );
  const text = c.store
    .messages(s.id)
    .map((m) => m.body)
    .join("");
  assert.match(text, /remote offline work/);
  await c.orchestration.send(
    { session: s.id, text: "/slow remote offline work", requestId: command },
    owner,
  );
  assert.equal(db.commands(s.id).length, 1);
  assert.equal(c.store.messages(s.id).filter((m) => m.role === "user").length, 1);
  const before = c.store.db
    .prepare("SELECT COUNT(*) n FROM events WHERE origin=?")
    .get(identity.host) as { n: number };
  gateway.disconnect();
  await until(
    () => c.store.host(identity.host).status,
    (v) => v === "offline",
  );
  await until(
    () => c.store.host(identity.host).status,
    (v) => v === "online",
  );
  const after = c.store.db
    .prepare("SELECT COUNT(*) n FROM events WHERE origin=?")
    .get(identity.host) as { n: number };
  assert.equal(after.n, before.n);
  await c.orchestration.send(
    { session: s.id, text: "/hang", requestId: "interrupted-command" },
    owner,
  );
  await gateway.stop();
  db.close();
  db = new Store(path);
  gateway = new Gateway(db, options, project);
  gateway.start();
  await until(
    () => c.store.session(s.id).status,
    (v) => v === "interrupted",
  );
  assert.equal(db.get<Command>("command", "interrupted-command")?.status, "interrupted");
  await until(
    () => c.store.host(identity.host).status,
    (v) => v === "online",
  );
  await c.orchestration.action(s.id, "resume", owner);
  await until(
    () => c.store.session(s.id).status,
    (v) => v === "idle",
  );
  assert.equal(c.store.messages(s.id).filter((m) => m.role === "user").length, 2);
  const revoke = await c.app.inject({
    method: "POST",
    url: `/api/hosts/${identity.host}/revoke`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {},
  });
  assert.equal(revoke.statusCode, 200);
  assert.equal(c.store.authenticate(identity.token), undefined);
  assert.equal(c.store.host(identity.host).status, "revoked");
});
test("Gateway enforces TLS outside explicitly permitted loopback development", async (t) => {
  const c = await setup(t),
    db = new Store(":memory:");
  t.after(() => db.close());
  assert.throws(
    () =>
      new Gateway(
        db,
        {
          center: "http://example.com",
          token: "long-enough-test-secret",
          host: "test",
          root: c.root,
          agents: [],
          insecureLocal: true,
        },
        project,
      ),
    { code: "TLS_REQUIRED" },
  );
});
