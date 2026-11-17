import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCommandLine,
  formatCommandLine,
  formatPastedWindowsPath,
  parseEnvironment,
  expandEnvironment,
  agentEnvironment,
} from "../packages/core/src/agent-command.js";

test("Agent command accepts shell quoting without executing shell syntax", () => {
  assert.deepEqual(parseCommandLine('"C:/Program Files/Agent/agent.exe" --model "large model"'), [
    "C:/Program Files/Agent/agent.exe",
    "--model",
    "large model",
  ]);
  assert.deepEqual(parseCommandLine(formatCommandLine("/bin/agent", ["a b", "plain"])), [
    "/bin/agent",
    "a b",
    "plain",
  ]);
  assert.throws(() => parseCommandLine("agent | cat"), /不执行/);
  assert.throws(() => parseCommandLine("agent 'unclosed"), /引号/);
});

test("Windows paste formatting handles absolute paths and preserves ordinary text", () => {
  assert.equal(
    formatPastedWindowsPath("C:\\Program Files\\Agent\\agent.exe"),
    '"C:/Program Files/Agent/agent.exe"',
  );
  assert.equal(formatPastedWindowsPath("D:\\Agent\\agent.exe"), "D:/Agent/agent.exe");
  assert.equal(formatPastedWindowsPath("agent --flag"), null);
});

test("environment input splits on the first equals and expands existing variables", () => {
  assert.deepEqual(parseEnvironment("A=one=two\nB=$HOME/cache\n"), {
    A: "one=two",
    B: "$HOME/cache",
  });
  assert.deepEqual(expandEnvironment({ B: "$HOME/${USER}/$$" }, { HOME: "/tmp", USER: "alice" }), {
    B: "/tmp/alice/$",
  });
  assert.throws(() => expandEnvironment({ A: "$MISSING" }, {}), /不存在/);
  assert.deepEqual(
    agentEnvironment({ PATH: "$HOME/bin", EXTRA: "ok" }, { HOME: "/work", PATH: "/bin", ACPAO_ADMIN_TOKEN: "secret" }),
    { HOME: "/work", PATH: "/work/bin", EXTRA: "ok" },
  );
});
