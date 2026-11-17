import { build } from "esbuild";
import { readdir, mkdir, writeFile, copyFile, chmod, rm } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { spawnSync } from "node:child_process";
const root = process.cwd(),
  out = resolve(root, "sea-build"),
  web = resolve(root, "apps/web/dist");
await mkdir(out, { recursive: true });
const entries = {
  server: "apps/server/src/main.ts",
  gateway: "apps/gateway/src/main.ts",
  "mcp-bridge": "scripts/mcp-bridge.mjs",
  "mock-agent": "scripts/mock-agent.mjs",
};
for (const [name, entry] of Object.entries(entries))
  await build({
    entryPoints: [resolve(root, entry)],
    outfile: resolve(out, name + ".mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "bundle",
    banner: {
      js: `import {createRequire as __seaCreateRequire} from 'node:module';const require=__seaCreateRequire(import.meta.url);`,
    },
    external: ["node:*"],
  });
async function walk(dir) {
  let result = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const file = resolve(dir, d.name);
    if (d.isDirectory()) result.push(...(await walk(file)));
    else result.push(file);
  }
  return result;
}
const files = await walk(web),
  names = files.map((f) => relative(web, f).replaceAll("\\", "/"));
await writeFile(resolve(out, "web-files.json"), JSON.stringify(names));
for (const file of files) {
  const name = relative(web, file).replaceAll("\\", "/");
  await mkdir(dirname(resolve(out, "web", name)), { recursive: true });
  await copyFile(file, resolve(out, "web", name));
}
const launcher = resolve(root, "scripts/sea/entry.cjs");
const config = {
  main: launcher,
  output: resolve(out, "acpao-sea.blob"),
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets: {},
};
for (const key of ["server", "gateway", "mcp-bridge", "mock-agent", "web-files.json"])
  config.assets[key] = resolve(out, key === "web-files.json" ? key : key + ".mjs");
for (const name of names) config.assets["web/" + name] = resolve(out, "web", name);
await writeFile(resolve(out, "sea-config.json"), JSON.stringify(config, null, 2));
const exec = process.platform === "win32" ? "node.exe" : "node";
const n = spawnSync(exec, ["--experimental-sea-config", resolve(out, "sea-config.json")], {
  stdio: "inherit",
});
if (n.status !== 0) process.exit(n.status ?? 1);
const node = process.execPath,
  filename = process.platform === "win32" ? "acpao.exe" : "acpao";
await rm(resolve(out, filename), { force: true });
await copyFile(node, resolve(out, filename));
const postject = resolve(
  root,
  "node_modules/.bin",
  process.platform === "win32" ? "postject.cmd" : "postject",
);
const p = spawnSync(
  postject,
  [
    resolve(out, filename),
    "NODE_SEA_BLOB",
    resolve(out, "acpao-sea.blob"),
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);
if (p.status !== 0) process.exit(p.status ?? 1);
if (process.platform !== "win32") await chmod(resolve(out, filename), 0o755);
console.log(`Built ${resolve(out, filename)} (${names.length} embedded web assets)`);
