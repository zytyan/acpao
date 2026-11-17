import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { symlink } from "node:fs/promises";
import { setup, until, owner } from "./helpers.js";
import type { Command } from "../packages/core/src/types.js";
const create = async (c: Awaited<ReturnType<typeof setup>>, title = "新的工作") =>
  c.orchestration.create({ cwd: c.root, agent: "mock", title }, owner);
test("Session lifecycle streams real ACP output; duplicate ACP IDs stay isolated", async (t) => {
  const c = await setup(t),
    a = await create(c),
    b = await create(c);
  assert.notEqual(a.id, b.id);
  assert.equal(a.acpId, b.acpId);
  assert.notEqual(a.processId, b.processId);
  await c.orchestration.send({ session: a.id, text: "alpha-only" }, owner);
  await c.orchestration.send({ session: b.id, text: "beta-only" }, owner);
  await until(
    () => c.store.session(a.id).status,
    (s) => s === "completed",
  );
  await until(
    () => c.store.session(b.id).status,
    (s) => s === "completed",
  );
  assert.match(
    c.store
      .messages(a.id)
      .map((m) => m.body)
      .join(""),
    /alpha-only/,
  );
  assert.doesNotMatch(
    c.store
      .messages(a.id)
      .map((m) => m.body)
      .join(""),
    /beta-only/,
  );
  assert.ok(c.store.events(a.id, 0, 500).filter((e) => e.kind === "acp.update").length > 2);
  await c.orchestration.action(a.id, "close", owner);
  assert.equal(c.store.session(a.id).status, "closed");
});
test("same-session prompts serialize and preserve idempotency", async (t) => {
  const c = await setup(t),
    s = await create(c);
  const a = (await c.orchestration.send(
    { session: s.id, text: "/slow first", requestId: "request-first" },
    owner,
  )) as { delivery: string };
  const b = (await c.orchestration.send(
    { session: s.id, text: "second", requestId: "request-second" },
    owner,
  )) as { delivery: string };
  assert.equal(a.delivery, "immediate");
  assert.equal(b.delivery, "queued");
  const duplicate = (await c.orchestration.send(
    { session: s.id, text: "second", requestId: "request-second" },
    owner,
  )) as { delivery: string };
  assert.equal(duplicate.delivery, "duplicate");
  await assert.rejects(
    c.orchestration.send({ session: s.id, text: "changed", requestId: "request-second" }, owner),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  await until(
    () => c.store.get<Command>("command", "request-second")?.status,
    (s) => s === "completed",
  );
  assert.deepEqual(
    c.store
      .messages(s.id)
      .filter((m) => m.role === "user")
      .map((m) => m.body),
    ["/slow first", "second"],
  );
  const ends = c.store.events(s.id, 0, 1000).filter((e) => e.kind === "turn.end");
  assert.equal(ends.length, 2);
});
test("strong steering and immediate semantics reject instead of silently queuing", async (t) => {
  const c = await setup(t),
    s = await create(c);
  await assert.rejects(
    c.orchestration.send({ session: s.id, text: "steer", mode: "steer" }, owner),
    { code: "STEERING_UNSUPPORTED" },
  );
  await c.orchestration.send({ session: s.id, text: "/slow busy" }, owner);
  await assert.rejects(
    c.orchestration.send({ session: s.id, text: "now", mode: "immediate" }, owner),
    { code: "SESSION_BUSY" },
  );
  await c.orchestration.action(s.id, "cancel", owner);
  await until(
    () => c.store.session(s.id).status,
    (v) => v === "cancelled",
  );
});
test("agent process exit interrupts its session, without affecting peers", async (t) => {
  const c = await setup(t),
    a = await create(c),
    b = await create(c);
  await c.orchestration.send({ session: a.id, text: "/crash" }, owner);
  await until(
    () => c.store.session(a.id).status,
    (s) => s === "interrupted",
  );
  assert.equal(c.store.session(b.id).status, "idle");
  assert.equal(c.store.commands(a.id)[0]?.status, "interrupted");
});
test("human approval is required; cancelling resolves pending protocol permissions", async (t) => {
  const c = await setup(t),
    s = await create(c);
  await c.orchestration.send({ session: s.id, text: "/permission write" }, owner);
  await until(
    () => c.store.approvals(s.id),
    (a) => a.length === 1,
  );
  const a = c.store.approvals(s.id)[0]!;
  await assert.rejects(
    c.orchestration.approve(a.id, "yes", {
      kind: "agent",
      id: s.id,
      session: s.id,
      host: "local",
    }),
    { code: "FORBIDDEN" },
  );
  await c.orchestration.approve(a.id, "yes", owner);
  await until(
    () => c.store.session(s.id).status,
    (v) => v === "completed",
  );
  await c.orchestration.send({ session: s.id, text: "/permission again" }, owner);
  await until(
    () => c.store.approvals(s.id),
    (a) => a.length === 1,
  );
  await c.orchestration.action(s.id, "cancel", owner);
  await until(
    () => c.store.session(s.id).status,
    (v) => v === "cancelled",
  );
  assert.equal(c.store.approvals(s.id).length, 0);
});
test("timeout terminates process and never retries an ambiguous prompt", async (t) => {
  const c = await setup(t, { promptTimeoutMs: 150 }),
    s = await create(c);
  await c.orchestration.send({ session: s.id, text: "/hang" }, owner);
  await until(
    () => c.store.session(s.id).status,
    (v) => v === "interrupted",
  );
  assert.match(c.store.session(s.id).error!, /超时/);
  assert.equal(c.store.commands(s.id)[0]?.status, "failed");
});
test("noncooperative cancel escalates and cancels queued prompts", async (t) => {
  const c = await setup(t),
    s = await create(c);
  await c.orchestration.send({ session: s.id, text: "/hang" }, owner);
  await c.orchestration.send({ session: s.id, text: "never run this" }, owner);
  await c.orchestration.action(s.id, "cancel", owner);
  await until(
    () => c.store.session(s.id).status,
    (v) => v === "interrupted",
    6000,
  );
  assert.ok(c.store.commands(s.id).every((c) => c.status === "cancelled"));
});
test("cwd policy rejects paths outside root and symlink escape", async (t) => {
  const c = await setup(t);
  await assert.rejects(c.runtime.directory("/tmp"), {
    code: "DIRECTORY_FORBIDDEN",
  });
  await symlink("/tmp", resolve(c.root, "escape"));
  await assert.rejects(c.runtime.directory(resolve(c.root, "escape")), {
    code: "DIRECTORY_FORBIDDEN",
  });
});
test("resume is honest about unsupported capabilities", async (t) => {
  const c = await setup(t),
    s = await create(c);
  await c.orchestration.action(s.id, "close", owner);
  await assert.rejects(c.orchestration.action(s.id, "resume", owner), {
    code: "RESTORE_UNSUPPORTED",
  });
});

test("closing an active session leaves no running or queued commands", async (t) => {
  const c = await setup(t),
    s = await create(c);
  await c.orchestration.send({ session: s.id, text: "/hang" }, owner);
  await c.orchestration.send({ session: s.id, text: "queued" }, owner);
  await c.orchestration.action(s.id, "close", owner);
  assert.equal(c.store.session(s.id).status, "closed");
  assert.ok(c.store.commands(s.id).every((command) => command.status === "cancelled"));
});

test("Git worktree opt-in isolates edits while keeping the source repository intact", async (t) => {
  const { execFile } = await import("node:child_process"),
    { promisify } = await import("node:util"),
    { writeFile, readFile } = await import("node:fs/promises");
  const run = promisify(execFile),
    c = await setup(t);
  await run("git", ["init", "-q", c.root]);
  await writeFile(resolve(c.root, "baseline.txt"), "original\n");
  await run("git", ["-C", c.root, "add", "baseline.txt"]);
  await run("git", [
    "-C",
    c.root,
    "-c",
    "user.name=ACPAO Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "baseline",
  ]);
  const s = await c.orchestration.create({ cwd: c.root, agent: "mock", isolate: true }, owner);
  assert.notEqual(s.cwd, c.root);
  assert.match(s.cwd, /\.acpao-worktrees/);
  assert.equal(await readFile(resolve(s.cwd, "baseline.txt"), "utf8"), "original\n");
  await writeFile(resolve(s.cwd, "baseline.txt"), "isolated\n");
  assert.equal(await readFile(resolve(c.root, "baseline.txt"), "utf8"), "original\n");
});
