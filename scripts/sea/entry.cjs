"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { getAsset, isSea } = require("node:sea");
(async () => {
  if (!isSea()) throw new Error("ACPAO SEA executable required");
  if (process.argv.includes("--acpao-build-info")) {
    const { zstdDecompressSync } = require("node:zlib");
    const platforms = ["linux-x64", "linux-arm64", "windows-x64"];
    for (const platform of platforms) {
      const binary = zstdDecompressSync(Buffer.from(getAsset("gateways/" + platform + ".zst")));
      if (
        platform === "windows-x64"
          ? binary.toString("ascii", 0, 2) !== "MZ"
          : binary.toString("ascii", 1, 4) !== "ELF"
      )
        throw new Error("Invalid embedded Gateway: " + platform);
    }
    console.log("ACPAO standalone executable with embedded Gateways: " + platforms.join(", "));
    process.exit(0);
  }
  const command = process.env.ACPAO_SEA_MODE || process.argv[1],
    entry =
      command === "gateway"
        ? "gateway"
        : command === "mcp-bridge"
          ? "mcp-bridge"
          : command === "mock-agent"
            ? "mock-agent"
            : "server";
  const root = path.resolve(process.env.ACPAO_DATA_DIR ?? ".data", "runtime");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const name of JSON.parse(Buffer.from(getAsset("web-files.json")).toString())) {
    const file = path.join(root, "apps/web/dist", name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, Buffer.from(getAsset("web/" + name)));
  }
  const script = path.join(root, entry + ".mjs");
  fs.writeFileSync(script, Buffer.from(getAsset(entry)).toString(), { mode: 0o600 });
  process.env.ACPAO_EMBEDDED_WEB = path.join(root, "apps/web/dist");
  process.env.ACPAO_EMBEDDED_RUNTIME = root;
  if (!process.env.ACPAO_SEA_MODE && ["gateway", "mcp-bridge", "mock-agent"].includes(command))
    process.argv.splice(1, 1);
  await import(require("node:url").pathToFileURL(script).href);
})().catch((error) => {
  console.error("ACPAO startup failed:", error.message);
  process.exitCode = 1;
});
