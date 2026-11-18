import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, mkdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { setup, until, owner, project, adminToken } from "./helpers.js";

test(
  "Go Gateway pairs, runs an ACP Session and replays output to the center",
  { skip: !process.env.GO_GATEWAY_BIN },
  async (t) => {
    const c = await setup(t);
    const pairing = await c.app.inject({
      method: "POST",
      url: "/api/hosts/pairings",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Go remote test" },
    });
    assert.equal(pairing.statusCode, 200);
    const pair = pairing.json() as { code: string };
    const response = await fetch(c.url + "/api/gateway/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pair.code }),
    });
    assert.equal(response.status, 200);
    const identity = (await response.json()) as { host: string; token: string };
    const folder = resolve(c.root, "go-remote");
    await mkdir(folder);
    const file = resolve(folder, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        center: c.url,
        ...identity,
        root: c.root,
        insecureLocal: true,
        agents: [
          {
            id: "mock",
            name: "Go remote mock",
            command: process.execPath,
            args: [resolve(project, "scripts/mock-agent.mjs")],
            env: { MOCK_LOAD: "1", MOCK_STEERING: "1", MOCK_STDERR: "remote stderr sentinel",
              MOCK_TOKEN: "remote-secret-value-123" },
          },
        ],
      }),
    );
    let child: ChildProcess | undefined;
    t.after(() => {
      child?.kill();
    });
    child = spawn(process.env.GO_GATEWAY_BIN!, ["--foreground", "--config", file], {
      stdio: "pipe",
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    await until(
      () => c.store.host(identity.host).status,
      (status) => status === "online",
      15000,
    ).catch(() => {
      throw new Error(stderr);
    });
    const remoteAgent = {
      id: "custom-go",
      name: "Configured remotely",
      command: process.execPath,
      args: [resolve(project, "scripts/mock-agent.mjs")],
      env: { MOCK_LOAD: "1", MOCK_STEERING: "1", MOCK_STDERR: "remote stderr sentinel", MOCK_TOKEN: "remote-secret-value-123" },
    };
    const remoteConfigUrl = `/api/hosts/${identity.host}/agent`;
    const headers = { authorization: `Bearer ${adminToken}` };
    const nested = resolve(folder, "nested", "project");
    await mkdir(nested, { recursive: true });
    const listing = await c.app.inject({
      url: `/api/hosts/${identity.host}/directories`,
      headers,
      query: { cwd: resolve(folder, "nested") },
    });
    assert.equal(listing.statusCode, 200, listing.body);
    assert.deepEqual(listing.json().entries, [{ name: "project", path: nested }]);
    const forbidden = await c.app.inject({
      url: `/api/hosts/${identity.host}/directories`,
      headers,
      query: { cwd: resolve(c.root, "..") },
    });
    assert.notEqual(forbidden.statusCode, 200);
    const failed = await c.app.inject({
      method: "POST", url: remoteConfigUrl, headers,
      payload: { agent: { ...remoteAgent, command: resolve(c.root, "nonexistent-agent") } },
    });
    assert.equal(failed.json().ok, false);
    assert.ok(!c.store.host(identity.host).agents.some(a => a.id === remoteAgent.id));
    const added = await c.app.inject({ method: "POST", url: remoteConfigUrl, headers, payload: { agent: remoteAgent } });
    assert.equal(added.json().ok, true, added.body);
    await until(() => c.store.host(identity.host).agents.some(a => a.id === remoteAgent.id), Boolean);
    const edit = await c.app.inject({ url: `/api/hosts/${identity.host}/agents/${remoteAgent.id}`, headers });
    assert.deepEqual(edit.json(), remoteAgent);
    assert.equal(c.store.db.prepare("SELECT COUNT(*) AS n FROM objects WHERE kind='dispatch' AND data LIKE ?")
      .get("%remote-secret-value-123%")?.n, 0);
    const session = await c.orchestration.create(
      { host: identity.host, cwd: nested, agent: remoteAgent.id, title: "Go remote" },
      owner,
    );
    await until(
      () => c.store.session(session.id).status,
      (status) => status === "idle",
      15000,
    ).catch(() => {
      throw new Error(stderr);
    });
    assert.equal(c.store.session(session.id).cwd, nested);
    const model = await c.app.inject({ url: `/api/sessions/${session.id}/model`, method: "POST",
      headers, payload: { value: "mock-deep" } });
    assert.equal(model.statusCode, 200, model.body);
    assert.equal(model.json().current, "mock-deep");
    await until(
      async () => (await c.app.inject({ url: `/api/sessions/${session.id}`, headers })).json().model?.current,
      (value) => value === "mock-deep",
    );
    const readCommands = async () =>
      (await c.app.inject({ url: `/api/sessions/${session.id}`, headers })).json().slashCommands;
    const commands = await until(readCommands, (value) => value.some((command: { name: string }) => command.name === "mcp"));
    assert.ok(commands.some((command: { name: string; inputHint: string }) =>
      command.name === "delegate" && command.inputHint === "工作内容"));
    const diagnostic = await until(
      () => c.store.diagnostics().find((entry) => entry.message.includes("remote stderr sentinel")),
      (entry) => !!entry,
      10000,
    );
    assert.match(diagnostic!.message, /\[已隐藏\]/);
    assert.doesNotMatch(diagnostic!.message, /remote-secret-value-123/);
    const sent = (await c.orchestration.send(
      { session: session.id, text: "hello from Go gateway", requestId: "go-gateway-command" },
      owner,
    )) as { delivery: string };
    assert.equal(sent.delivery, "immediate");
    await until(
      () => c.store.session(session.id).status,
      (status) => status === "completed",
      15000,
    ).catch(() => {
      throw new Error(stderr);
    });
    assert.match(
      c.store
        .messages(session.id)
        .map((m) => m.body)
        .join(""),
      /hello from Go gateway/,
    );
    const duplicate = (await c.orchestration.send(
      { session: session.id, text: "hello from Go gateway", requestId: "go-gateway-command" },
      owner,
    )) as { delivery: string };
    assert.deepEqual(duplicate, sent);
    await c.orchestration.send(
      { session: session.id, text: "/delegate child-via-go-bridge" },
      owner,
    );
    await until(
      () => c.store.sessions().some((s) => s.parent === session.id),
      (exists) => exists,
      20000,
    ).catch(() => {
      throw new Error(stderr);
    });
    await until(
      () => c.store.session(session.id).status,
      (status) => status === "completed",
      20000,
    ).catch(() => {
      throw new Error(stderr);
    });
    await c.orchestration.send({ session: session.id, text: "/sleep 4000" }, owner);
    await until(
      () => c.store.session(session.id).status,
      (status) => status === "running",
      15000,
    );
    await c.orchestration.send(
      { session: session.id, text: "promote this", mode: "queue", requestId: "go-promote-command" },
      owner,
    );
    await until(
      () =>
        c.store
          .commands(session.id, "queued")
          .some((command) => command.id === "go-promote-command"),
      Boolean,
    );
    const promoted = await c.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/queue/go-promote-command/steer`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {},
    });
    assert.equal(promoted.statusCode, 200);
    assert.equal(promoted.json().delivery, "steering");
    await until(
      () => c.store.get<{ status: string }>("command", "go-promote-command")?.status,
      (status) => status === "completed",
    );
    await until(
      () => c.store.session(session.id).status,
      (status) => status === "completed",
      15000,
    );
    const before = c.store.db
      .prepare("SELECT COUNT(*) n, MAX(originSeq) cursor FROM events WHERE origin=?")
      .get(identity.host) as { n: number; cursor: number };
    for (const peer of c.remote.wss.clients) peer.terminate();
    await until(
      () => c.store.host(identity.host).status,
      (status) => status === "offline",
    );
    await until(
      () => c.store.host(identity.host).status,
      (status) => status === "online",
      15000,
    );
    const after = c.store.db
      .prepare("SELECT COUNT(*) n FROM events WHERE origin=? AND originSeq<=?")
      .get(identity.host, before.cursor) as { n: number };
    assert.equal(after.n, before.n);
    child.kill();
    await new Promise<void>((done) => child?.once("exit", () => done()));
    child = spawn(process.env.GO_GATEWAY_BIN!, ["--foreground", "--config", file], {
      stdio: "pipe",
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    await until(
      () => c.store.session(session.id).status,
      (status) => status === "idle",
      15000,
    ).catch(() => {
      throw new Error(stderr);
    });
    assert.equal(c.store.messages(session.id).filter((m) => m.role === "user").length, 4);
    assert.ok(c.store.host(identity.host).agents.some(a => a.id === remoteAgent.id));
    await until(readCommands, (value) => value.some((command: { name: string }) => command.name === "mcp"));
    await c.orchestration.send({ session: session.id, text: "/mcp" }, owner);
    await until(
      () => c.store.messages(session.id).some((message) => message.role === "assistant" && message.body.includes("MCP 服务：acpao")),
      Boolean,
    );
    const remoteAgentScope = { kind: "agent" as const, id: session.id, host: identity.host, session: session.id };
    const discovered = await c.orchestration.tool("hosts", {}, remoteAgentScope) as { id: string }[];
    assert.ok(discovered.some(host => host.id === "local"));
    assert.ok(discovered.some(host => host.id === identity.host));
    const delegated = await c.orchestration.tool("delegate", {
      host: "local", agent: "mock", instruction: "Cross-host delegation",
    }, remoteAgentScope) as { session: string };
    assert.equal(c.store.session(delegated.session).host, "local");
    assert.equal(c.store.session(delegated.session).parent, session.id);
    await until(() => c.store.session(delegated.session).status, status => status === "completed");
    const childScope = { kind: "agent" as const, id: delegated.session, host: "local", session: delegated.session };
    await assert.rejects(c.orchestration.tool("sessions", { action: "get", session: session.id }, childScope), {
      code: "FORBIDDEN",
    });
    await c.orchestration.tool("send", { session: session.id, text: "Cross-host reply" }, childScope);
    await until(() => c.store.messages(session.id).some(message =>
      message.role === "assistant" && message.body.includes("Cross-host reply")), Boolean);
    const finalChild = child;
    finalChild.kill();
    await new Promise<void>((done) => finalChild.once("exit", () => done()));
    child = undefined;
  },
);

test("Go Gateway --daemon detaches a manager and --stop ends it", { skip: !process.env.GO_GATEWAY_BIN }, async (t) => {
  const folder = await mkdtemp(resolve(tmpdir(), "acpao-go-daemon-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = resolve(folder, "config.json");
  await writeFile(file, JSON.stringify({ center: "http://127.0.0.1:9", host: "test", token: "long-enough-test-token",
    root: folder, agents: [], insecureLocal: true }));
  const launch = spawn(process.env.GO_GATEWAY_BIN!, ["--daemon", "--config", file]);
  assert.equal(await new Promise<number | null>((done) => launch.once("exit", done)), 0);
  const pidFile = resolve(folder, "manager.pid");
  await until(() => readFile(pidFile, "utf8").catch(() => ""), (value) => Number(value) > 0, 10000);
  const stop = spawn(process.env.GO_GATEWAY_BIN!, ["--stop", "--config", file]);
  assert.equal(await new Promise<number | null>((done) => stop.once("exit", done)), 0);
  await until(() => readFile(pidFile, "utf8").then(() => false).catch(() => true), Boolean, 10000);
});

test(
  "Go Gateway manager drains an active Prompt before staged upgrade",
  { skip: !process.env.GO_GATEWAY_BIN },
  async (t) => {
    const c = await setup(t);
    const pairing = await c.app.inject({
      method: "POST",
      url: "/api/hosts/pairings",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: "Go upgrade test" },
    });
    const pair = pairing.json() as { code: string };
    const response = await fetch(c.url + "/api/gateway/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pair.code }),
    });
    const identity = (await response.json()) as { host: string; token: string };
    const folder = resolve(c.root, "upgrade-remote");
    await mkdir(folder);
    const file = resolve(folder, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        center: c.url,
        ...identity,
        root: c.root,
        insecureLocal: true,
        agents: [
          {
            id: "mock",
            name: "Upgrade mock",
            command: process.execPath,
            args: [resolve(project, "scripts/mock-agent.mjs")],
            env: { MOCK_LOAD: "1" },
          },
        ],
      }),
    );
    const manager = spawn(process.env.GO_GATEWAY_BIN!, ["--manager", "--config", file], {
      stdio: "pipe",
    });
    let stderr = "";
    manager.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    try {
      await until(
        () => c.store.host(identity.host).status,
        (status) => status === "online",
        15000,
      ).catch(() => {
        throw new Error(stderr);
      });
      const session = await c.orchestration.create(
        { host: identity.host, cwd: c.root, agent: "mock" },
        owner,
      );
      await until(
        () => c.store.session(session.id).status,
        (status) => status === "idle",
        15000,
      );
      await c.orchestration.send({ session: session.id, text: "/sleep 5000" }, owner);
      await until(
        () => c.store.session(session.id).status,
        (status) => status === "running",
        15000,
      );
      const upgrade = spawn(
        process.env.GO_GATEWAY_BIN!,
        ["--config", file, "--upgrade", process.env.GO_GATEWAY_BIN!],
        { stdio: "pipe" },
      );
      await new Promise<void>((done, reject) =>
        upgrade.once("exit", (code) =>
          code === 0 ? done() : reject(new Error(`upgrade exited ${code}`)),
        ),
      );
      await until(
        () => c.store.host(identity.host).status,
        (status) => status === "offline",
        15000,
      );
      await until(
        () => c.store.host(identity.host).status,
        (status) => status === "online",
        20000,
      );
      await until(
        () => c.store.session(session.id).status,
        (status) => status === "idle",
        20000,
      ).catch(() => {
        throw new Error(stderr);
      });
      assert.ok(c.store.events(session.id, 0, 1000).some((event) => event.kind === "turn.end"));
      assert.match(
        c.store
          .messages(session.id)
          .map((message) => message.body)
          .join(""),
        /sleep 5000/,
      );
    } finally {
      manager.kill();
      await new Promise<void>((done) => manager.once("exit", () => done()));
    }
  },
);
