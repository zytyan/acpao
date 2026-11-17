import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const binary = resolve(process.argv[2] ?? "sea-build/acpao");
const data = await mkdtemp(resolve(tmpdir(), "acpao-sea-smoke-"));
const port = String(18000 + Math.floor(Math.random() * 30000));
const child = spawn(binary, ["--no-browser"], {
  env: { ...process.env, ACPAO_DATA_DIR: data, ACPAO_ROOT: data, ACPAO_DEMO: "1", PORT: port },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => (output += chunk.toString()));
child.stderr.on("data", (chunk) => (output += chunk.toString()));
try {
  let token;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Executable exited early: ${output}`);
    try {
      token = (await readFile(resolve(data, "admin-token"), "utf8")).trim();
      const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
      if (response.status === 401) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  if (!ready || !token) throw new Error(`Server did not become ready: ${output}`);
  if (!new RegExp(`^http://127\\.0\\.0\\.1:${port}/#launch=[A-Za-z0-9_-]+$`).test(output.trim()))
    throw new Error(`Manual mode did not print exactly one authorized URL: ${output}`);
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!login.ok) throw new Error(`Login failed: ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  const created = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ agent: "mock", cwd: data }),
  });
  if (!created.ok) throw new Error(`ACP Session failed: ${created.status} ${await created.text()} ${output}`);
  const session = await created.json();
  if (!session.id || !session.acpId) throw new Error("ACP Session IDs missing");
  console.log(`Standalone executable launched and created ACP Session ${session.id}`);
} finally {
  child.kill();
  if (child.exitCode === null) await new Promise((done) => child.once("exit", done));
  await rm(data, { recursive: true, force: true });
}
