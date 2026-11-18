import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AppError } from "./types.js";

export async function findAgentExecutable(command: string, cwd: string, env = process.env) {
  const windows = process.platform === "win32";
  const path = Object.entries(env).find(([name]) => name.toUpperCase() === "PATH")?.[1] ?? "";
  const directories =
    isAbsolute(command) || /[\\/]/.test(command)
      ? [cwd]
      : path.split(windows ? ";" : ":").filter(Boolean);
  const extensions =
    windows && !/\.(exe|com|cmd|bat)$/i.test(command) ? [".exe", ".com", ".cmd", ".bat"] : [""];
  for (const directory of directories)
    for (const extension of extensions) {
      const file = resolve(cwd, directory.replace(/^"|"$/g, ""), command + extension);
      const info = await stat(file).catch(() => undefined);
      if (info?.isFile() && (windows || info.mode & 0o111)) return file;
    }
  return undefined;
}

export async function prepareAgentSpawn(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  if (process.platform !== "win32") return { command, args, verbatim: false };
  const executable = (await findAgentExecutable(command, cwd, env)) ?? command;
  if (!/\.(cmd|bat)$/i.test(executable)) return { command: executable, args, verbatim: false };
  if ([executable, ...args].some((value) => /["%&|<>^!\u0000-\u001f]/.test(value))) {
    throw new AppError(
      "WINDOWS_SHIM_ARGUMENT",
      "Windows 批处理启动器无法安全传递批处理特殊字符。请改用实际的 .exe 或用 node.exe 启动适配器脚本。",
    );
  }
  const systemRoot =
    process.env.SystemRoot ?? dirname(process.env.ComSpec ?? "C:/Windows/System32/cmd.exe") + "/..";
  const commandLine = [executable.replaceAll("/", "\\"), ...args]
    .map((value) => '"' + value + '"')
    .join(" ");
  return {
    command: join(systemRoot, "System32", "cmd.exe"),
    args: ["/d", "/v:off", "/s", "/c", '"' + commandLine + '"'],
    verbatim: true,
  };
}
