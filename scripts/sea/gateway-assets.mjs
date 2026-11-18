import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { constants, zstdCompressSync } from "node:zlib";

const output = resolve("sea-build/gateways");
await mkdir(output, { recursive: true });
for (const [name, GOOS, GOARCH] of [
  ["linux-x64", "linux", "amd64"],
  ["linux-arm64", "linux", "arm64"],
  ["windows-x64", "windows", "amd64"],
]) {
  const binary = resolve(output, "acpao-gateway-" + name + (GOOS === "windows" ? ".exe" : ""));
  const build = spawnSync(
    "go",
    ["build", "-buildvcs=false", "-trimpath", "-ldflags=-s -w", "-o", binary, "."],
    {
      cwd: resolve("apps/gateway-go"),
      env: { ...process.env, GOOS, GOARCH, CGO_ENABLED: "0" },
      stdio: "inherit",
    },
  );
  if (build.status !== 0) throw build.error ?? new Error("Gateway build failed: " + name);
  const bytes = await readFile(binary);
  await writeFile(
    resolve(output, name + ".zst"),
    zstdCompressSync(bytes, {
      params: { [constants.ZSTD_c_compressionLevel]: 12 },
    }),
  );
}
