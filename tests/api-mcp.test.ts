import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { setup, owner, adminToken, until } from "./helpers.js";
test("startup link creates a cookie and can be redeemed only once", async (t) => {
  const launchToken = "single-use-startup-link-token-123456";
  const c = await setup(t, { launchToken });
  const login = await c.app.inject({
    method: "POST",
    url: "/api/login",
    payload: { token: launchToken },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"] as string;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Max-Age=315360000/);
  assert.equal((await c.app.inject({ url: "/api/config", headers: { cookie } })).statusCode, 200);
  const resumed = await c.app.inject({ url: "/api/auth", headers: { cookie } });
  assert.equal(resumed.json().authenticated, true);
  assert.match(resumed.headers["set-cookie"] as string, /Max-Age=315360000/);
  assert.equal(
    (
      await c.app.inject({
        method: "POST",
        url: "/api/login",
        payload: { token: launchToken },
      })
    ).statusCode,
    401,
  );
});
test("Agent configuration is saved only after a real ACP session opens", async (t) => {
  const c = await setup(t);
  const missing = await c.app.inject({
    method: "POST",
    url: "/api/hosts/local/agent",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      agent: { id: "missing", name: "Missing", command: "/no/such/acp-agent", args: [], env: {} },
    },
  });
  assert.equal(missing.json().ok, false);
  assert.equal(c.store.host("local").agents.some((a) => a.id === "missing"), false);
  const broken = resolve(c.root, "broken-agent.mjs");
  await writeFile(broken, 'console.error("Adapter login failed"); process.exit(1);');
  const failed = await c.app.inject({
    method: "POST",
    url: "/api/hosts/local/agent",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      agent: { id: "broken", name: "Broken", command: process.execPath, args: [broken], env: {} },
    },
  });
  assert.equal(failed.json().ok, false);
  assert.match(failed.json().probe.stderr, /Adapter login failed/);
  assert.equal(c.store.host("local").agents.some((a) => a.id === "broken"), false);
  assert.ok(c.store.diagnostics().some((entry) => entry.code === "AGENT_PROBE_STDERR"));
  const mock = c.store.host("local").agents[0]!;
  const updated = await c.app.inject({
    method: "POST",
    url: "/api/hosts/local/agent",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { agent: { ...mock, name: "Checked Agent" } },
  });
  assert.equal(updated.json().ok, true);
  assert.equal(c.store.host("local").agents.find((a) => a.id === mock.id)?.name, "Checked Agent");
  const detail = await c.app.inject({
    url: `/api/hosts/local/agents/${mock.id}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(detail.json().command, mock.command);
  const disabled = await c.app.inject({
    method: "POST",
    url: "/api/settings/test-features",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(
    (await c.app.inject({ method: "POST", url: "/api/hosts/local/agent", headers: { authorization: `Bearer ${adminToken}` }, payload: { agent: mock } })).statusCode,
    403,
  );
});
test("HTTP auth, cookie login, origin checks and role boundaries", async (t) => {
  const c = await setup(t);
  assert.equal((await c.app.inject("/api/sessions")).statusCode, 401);
  const bad = await c.app.inject({
    method: "POST",
    url: "/api/login",
    payload: { token: "wrong" },
  });
  assert.equal(bad.statusCode, 401);
  const login = await c.app.inject({
    method: "POST",
    url: "/api/login",
    payload: { token: adminToken },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"] as string;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal((await c.app.inject({ url: "/api/hosts", headers: { cookie } })).statusCode, 200);
  assert.equal(
    (
      await c.app.inject({
        url: "/api/hosts",
        headers: { cookie, origin: "https://evil.test" },
      })
    ).statusCode,
    403,
  );
  const s = await c.orchestration.create({ cwd: c.root }, owner),
    other = await c.orchestration.create({ cwd: c.root }, owner);
  const token = "scoped-agent-test-token";
  c.store.credential(token, {
    kind: "agent",
    id: s.id,
    session: s.id,
    host: "local",
  });
  const sshDeploy = {
    method: "POST" as const,
    url: "/api/hosts/ssh",
    payload: { name: "Test host", target: "-oProxyCommand=unexpected" },
  };
  assert.equal((await c.app.inject({
    ...sshDeploy, headers: { authorization: `Bearer ${token}` },
  })).statusCode, 403);
  assert.equal((await c.app.inject({
    ...sshDeploy, headers: { cookie },
  })).statusCode, 400);
  assert.equal(
    (
      await c.app.inject({
        url: "/api/hosts",
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode,
    403,
  );
  await assert.rejects(
    c.orchestration.tool(
      "sessions",
      { action: "get", session: other.id },
      { kind: "agent", id: s.id, session: s.id, host: "local" },
    ),
    { code: "FORBIDDEN" },
  );
  assert.equal(
    (
      await c.app.inject({
        method: "POST",
        url: "/api/tools/hosts",
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      })
    ).statusCode,
    200,
  );
});
test("real MCP HTTP SDK lists tools, browses directories and delegates in the selected directory", async (t) => {
  const c = await setup(t),
    client = new Client({ name: "integration", version: "1" });
  t.after(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", c.url), {
      requestInit: { headers: { authorization: `Bearer ${adminToken}` } },
    }),
  );
  const list = await client.listTools();
  assert.deepEqual(list.tools.map((t) => t.name).sort(), [
    "delegate",
    "directories",
    "hosts",
    "send",
    "sessions",
    "wait",
  ]);
  const target = resolve(c.root, "work", "nested");
  await mkdir(target, { recursive: true });
  const browse = await client.callTool({ name: "directories", arguments: { cwd: resolve(c.root, "work") } });
  assert.equal(browse.isError, undefined);
  const dirs = JSON.parse((browse.content as { text: string }[])[0]!.text);
  assert.deepEqual(dirs.entries, [{ name: "nested", path: target }]);
  const result = await client.callTool({
    name: "delegate",
    arguments: { instruction: "MCP integration", cwd: target, agent: "mock" },
  });
  assert.ok(!result.isError);
  const data = JSON.parse((result.content as { text: string }[])[0]!.text);
  assert.equal(data.cwd, target);
  const wait = await client.callTool({
    name: "wait",
    arguments: {
      sessions: [data.session],
      until: "terminal",
      timeoutMs: 10000,
    },
  });
  const done = JSON.parse((wait.content as { text: string }[])[0]!.text);
  assert.equal(done.sessions[0].status, "completed");
  assert.match(done.sessions[0].summary, /MCP integration/);
  const error = await client.callTool({
    name: "send",
    arguments: { session: data.session, text: "steer", mode: "steer" },
  });
  assert.equal(error.isError, true);
  assert.match((error.content as { text: string }[])[0]!.text, /STEERING_UNSUPPORTED/);
});

test("directory switch keeps existing history, updates workspace and validates directory boundaries", async (t) => {
  const c = await setup(t);
  const headers = { authorization: `Bearer ${adminToken}` };
  const folder = resolve(c.root, "..literal", "nested");
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(c.root, "file.txt"), "");
  if (process.platform !== "win32") await symlink(resolve(c.root, ".."), resolve(c.root, "escape"));
  const url = "/api/hosts/local/directories";
  assert.equal((await c.app.inject({ url })).statusCode, 401);
  const root = await c.app.inject({ url, headers });
  assert.ok(root.json().entries.some((e: { name: string }) => e.name === "..literal"));
  assert.ok(root.json().entries.every((e: { name: string }) => !["file.txt", "escape"].includes(e.name)));
  const outside = await c.app.inject({ url, headers, query: { cwd: resolve(c.root, "..") } });
  assert.equal(outside.json().error.code, "DIRECTORY_FORBIDDEN");
  const old = await c.orchestration.create({ cwd: c.root, agent: "mock", main: true }, owner);
  await c.orchestration.send({ session: old.id, text: "history stays" }, owner);
  await until(() => c.store.session(old.id).status, (status) => status === "completed");
  const moved = await c.app.inject({
    url: `/api/sessions/${old.id}/directory`, method: "POST", headers, payload: { cwd: folder },
  });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().cwd, folder);
  assert.equal(c.store.get("setting", "main"), moved.json().id);
  assert.notEqual(moved.json().id, old.id);
  assert.ok(c.store.messages(old.id).some((message) => message.body.includes("history stays")));
});

test("model switching uses ACP advertised choices and waits for an idle session", async (t) => {
  const c = await setup(t);
  const original = await c.orchestration.create({ cwd: c.root, agent: "mock" }, owner);
  const headers = { authorization: `Bearer ${adminToken}` };
  const detail = `/api/sessions/${original.id}`;
  const get = () => c.app.inject({ url: detail, headers });
  const set = (value: string) => c.app.inject({ url: detail + "/model", method: "POST", headers, payload: { value } });
  assert.equal((await get()).json().model.current, "mock-fast");
  assert.equal((await set("hallucinated")).json().error.code, "MODEL_NOT_FOUND");
  await c.orchestration.send({ session: original.id, text: "/sleep 500" }, owner);
  assert.equal((await set("mock-deep")).json().error.code, "SESSION_BUSY");
  await until(() => c.store.session(original.id).status, (status) => status === "completed");
  const change = c.orchestration.setModel(original.id, "mock-deep", owner);
  const queued = await c.orchestration.send({ session: original.id, text: "/current-model" }, owner) as { delivery: string };
  assert.equal(queued.delivery, "queued");
  await change;
  await until(() => c.store.session(original.id).status, (status) => status === "completed");
  const active = (await get()).json();
  assert.equal(active.model.current, "mock-deep");
  assert.equal(active.session.acpId, original.acpId);
  assert.equal(active.messages.at(-1).body, "mock-deep");
});
test("parent ACP Agent delegates through a real stdio MCP bridge and reports output", async (t) => {
  const c = await setup(t),
    s = await c.orchestration.create({ cwd: c.root, title: "主 Agent" }, owner);
  await c.orchestration.send({ session: s.id, text: "/delegate 检查队列" }, owner);
  await until(
    () => c.store.session(s.id).status,
    (v) => v === "completed",
    20000,
  );
  const children = c.store.sessions().filter((x) => x.parent === s.id);
  assert.equal(children.length, 1);
  assert.equal(children[0]!.status, "completed");
  assert.match(
    c.store
      .messages(s.id)
      .map((x) => x.body)
      .join(""),
    /测试委派结果/,
  );
  assert.match(
    c.store
      .messages(children[0]!.id)
      .map((x) => x.body)
      .join(""),
    /检查队列/,
  );
});
test("wait supports multiple sessions and removes timeout listeners", async (t) => {
  const c = await setup(t),
    a = await c.orchestration.create({ cwd: c.root }, owner),
    b = await c.orchestration.create({ cwd: c.root }, owner);
  const start = c.store.cursor();
  const result = (await c.orchestration.tool(
    "wait",
    { sessions: [a.id, b.id], cursor: start, timeoutMs: 30 },
    owner,
  )) as { timedOut: boolean; cursor: number };
  assert.equal(result.timedOut, true);
  assert.equal(c.store.changes.listenerCount("event"), 0);
});

test("parallel delegate retries reserve one session; repeated request IDs cannot duplicate work", async (t) => {
  const c = await setup(t);
  const input = {
    instruction: "one delegation only",
    cwd: c.root,
    requestId: "same-delegation-request",
  };
  const [a, b] = (await Promise.all([
    c.orchestration.tool("delegate", input, owner),
    c.orchestration.tool("delegate", input, owner),
  ])) as { session: string }[];
  assert.equal(a!.session, b!.session);
  assert.equal(c.store.sessions().length, 1);
  await until(
    () => c.store.session(a!.session).status,
    (v) => v === "completed",
  );
  assert.equal(c.store.commands(a!.session).length, 1);
  await assert.rejects(
    c.orchestration.tool("delegate", { ...input, instruction: "changed" }, owner),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
});
test("wait does not lose target events behind another session’s busy stream", async (t) => {
  const c = await setup(t),
    a = await c.orchestration.create({ cwd: c.root }, owner),
    b = await c.orchestration.create({ cwd: c.root }, owner);
  const cursor = c.store.cursor();
  for (let n = 0; n < 510; n++) c.store.event(a.id, "noise", {});
  c.store.event(b.id, "queued", { command: "signal" });
  const r = (await c.orchestration.tool(
    "wait",
    { sessions: [b.id], cursor, timeoutMs: 10 },
    owner,
  )) as { timedOut: boolean; progress: unknown[] };
  assert.equal(r.timedOut, false);
  assert.equal(r.progress.length, 1);
});

test("SSE reconnect cursors and graceful shutdown release live subscribers", async (t) => {
  const c = await setup(t);
  const response = await fetch(c.url + "/api/stream?cursor=0", {
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const initial = await reader.read();
  assert.match(new TextDecoder().decode(initial.value), /retry: 1500/);
  c.store.event("", "test-change", {});
  const update = await reader.read();
  assert.match(new TextDecoder().decode(update.value), /event: change/);
  await c.app.close();
  const tail = await reader.read();
  assert.equal(tail.done, true);
});
