import { spawnSync } from "node:child_process";

export function openBrowser(url: string, manual = false): boolean {
  if (manual) return false;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
    return false;
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const result = spawnSync(command, args, {
    stdio: "ignore",
    windowsHide: true,
    timeout: 3000,
  });
  return !result.error && result.status === 0;
}
