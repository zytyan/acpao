import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAsset, isSea } from "node:sea";
import { zstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import { AppError } from "../../../packages/core/src/types.js";

export type GatewayPlatform = "linux-x64" | "linux-arm64" | "windows-x64";

export async function gatewayBinary(platform: GatewayPlatform, project: string) {
  try {
    const packed = isSea()
      ? Buffer.from(getAsset("gateways/" + platform + ".zst"))
      : await readFile(resolve(project, "sea-build/gateways", platform + ".zst"));
    return await promisify(zstdDecompress)(packed, { maxOutputLength: 64 * 1024 * 1024 });
  } catch {
    throw new AppError(
      "GATEWAY_BINARY_MISSING",
      "找不到可用的内置 Gateway。源码模式请先运行 npm run build:gateway-assets。",
      503,
    );
  }
}
