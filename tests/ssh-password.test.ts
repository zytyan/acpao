import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SshPasswordVault } from "../apps/server/src/ssh-password.js";

test("SSH passwords are sealed to a host and recover after reopening the vault", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "acpao-ssh-vault-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const password = " a password with spaces and \"quotes\" ";
  const first = new SshPasswordVault(root);
  const sealed = await first.seal("host-one", password);
  assert.ok(!JSON.stringify(sealed).includes(password));
  const restarted = new SshPasswordVault(root);
  assert.equal(await restarted.open("host-one", sealed), password);
  await assert.rejects(restarted.open("host-two", sealed));
  if (process.platform !== "win32") {
    assert.equal((await stat(join(root, "ssh-secrets", "key"))).mode & 0o777, 0o600);
  }
});
