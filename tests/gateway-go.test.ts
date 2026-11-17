import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setup, until, owner, project, adminToken } from "./helpers.js";

test("Go Gateway pairs, runs an ACP Session and replays output to the center", { skip: !process.env.GO_GATEWAY_BIN }, async (t) => {
  const c = await setup(t);
  const pairing = await c.app.inject({ method: "POST", url: "/api/hosts/pairings",
    headers: { authorization: `Bearer ${adminToken}` }, payload: { name: "Go remote test" } });
  assert.equal(pairing.statusCode, 200);
  const pair = pairing.json() as { code: string };
  const response = await fetch(c.url + "/api/gateway/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: pair.code }) });
  assert.equal(response.status, 200);
  const identity = await response.json() as { host: string; token: string };
  const folder = resolve(c.root, "go-remote");
  await mkdir(folder);
  const file = resolve(folder, "config.json");
  await writeFile(file, JSON.stringify({ center: c.url, ...identity, root: c.root, insecureLocal: true,
    agents: [{ id: "mock", name: "Go remote mock", command: process.execPath,
      args: [resolve(project, "scripts/mock-agent.mjs")], env: { MOCK_LOAD: "1" } }] }));
  let child: ChildProcess | undefined;
  t.after(() => { child?.kill(); });
  child = spawn(process.env.GO_GATEWAY_BIN!, ["--foreground", "--config", file], { stdio: "pipe" });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  await until(() => c.store.host(identity.host).status, (status) => status === "online", 15000).catch(() => { throw new Error(stderr); });
  const session = await c.orchestration.create({ host: identity.host, cwd: c.root, agent: "mock", title: "Go remote" }, owner);
  await until(() => c.store.session(session.id).status, (status) => status === "idle", 15000).catch(() => { throw new Error(stderr); });
  const sent = await c.orchestration.send({ session: session.id, text: "hello from Go gateway", requestId: "go-gateway-command" }, owner) as { delivery: string };
  assert.equal(sent.delivery, "immediate");
  await until(() => c.store.session(session.id).status, (status) => status === "completed", 15000).catch(() => { throw new Error(stderr); });
  assert.match(c.store.messages(session.id).map((m) => m.body).join(""), /hello from Go gateway/);
  const duplicate = await c.orchestration.send({ session: session.id, text: "hello from Go gateway", requestId: "go-gateway-command" }, owner) as { delivery: string };
  assert.deepEqual(duplicate, sent);
  await c.orchestration.send({ session: session.id, text: "/delegate child-via-go-bridge" }, owner);
  await until(() => c.store.sessions().some((s) => s.parent === session.id), (exists) => exists, 20000).catch(() => { throw new Error(stderr); });
  await until(() => c.store.session(session.id).status, (status) => status === "completed", 20000).catch(() => { throw new Error(stderr); });
  const before = c.store.db.prepare("SELECT COUNT(*) n FROM events WHERE origin=?").get(identity.host) as { n: number };
  for (const peer of c.remote.wss.clients) peer.terminate();
  await until(() => c.store.host(identity.host).status, (status) => status === "offline");
  await until(() => c.store.host(identity.host).status, (status) => status === "online", 15000);
  const after = c.store.db.prepare("SELECT COUNT(*) n FROM events WHERE origin=?").get(identity.host) as { n: number };
  assert.equal(after.n, before.n);
  child.kill();
  await new Promise<void>((done) => child?.once("exit", () => done()));
  child = spawn(process.env.GO_GATEWAY_BIN!, ["--foreground", "--config", file], { stdio: "pipe" });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  await until(() => c.store.session(session.id).status, (status) => status === "idle", 15000).catch(() => { throw new Error(stderr); });
  assert.equal(c.store.messages(session.id).filter((m) => m.role === "user").length, 2);
  const finalChild = child;
  finalChild.kill();
  await new Promise<void>((done) => finalChild.once("exit", () => done()));
  child = undefined;
});
