/** Parse shell-style quoting into argv. This parser never executes a shell. */
export function parseCommandLine(input: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && /["\\$`]/.test(input[i + 1] ?? "")) word += input[++i];
      else word += char;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\") {
      if (i + 1 >= input.length) throw new Error("命令末尾不能只有反斜杠");
      word += input[++i];
      started = true;
    } else if (/[|&;<>`]/.test(char) || (char === "$" && input[i + 1] === "(")) {
      throw new Error("启动命令仅接受程序和参数，不执行管道或 Shell 表达式");
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("启动命令的引号没有闭合");
  if (started) words.push(word);
  if (!words[0]) throw new Error("请输入启动程序");
  return words;
}

export function formatCommandLine(command: string, args: string[] = []): string {
  return [command, ...args]
    .map((value) =>
      /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value)
        ? value
        : `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    )
    .join(" ");
}

export function formatPastedWindowsPath(value: string): string | null {
  const path = value.trim();
  if (!/^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]).+/.test(path)) return null;
  if (/[\r\n"]/u.test(path)) return null;
  const normalized = path.replaceAll("\\", "/");
  return /\s/.test(normalized) ? `"${normalized}"` : normalized;
}

export function parseEnvironment(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [index, line] of input.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const equal = line.indexOf("=");
    if (equal < 1) throw new Error(`环境变量第 ${index + 1} 行需要 NAME=值`);
    const name = line.slice(0, equal).trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
      throw new Error(`环境变量第 ${index + 1} 行名称无效`);
    result[name] = line.slice(equal + 1);
  }
  return result;
}

export function expandEnvironment(
  overrides: Record<string, string>,
  inherited: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(overrides))
    result[name] = value.replace(/\$\$|\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, braced: string | undefined, plain: string | undefined) => {
      if (match === "$$") return "$";
      const key = braced ?? plain!;
      const existing = inherited[key];
      if (existing === undefined) throw new Error(`环境变量 ${key} 不存在`);
      return existing;
    });
  return result;
}

export function agentEnvironment(
  overrides: Record<string, string>,
  inherited: Record<string, string | undefined>,
  platform = "linux",
): Record<string, string | undefined> {
  const environment = { ...inherited };
  for (const secret of ["ACPAO_ADMIN_TOKEN", "ACPAO_PAIR_CODE", "ACPAO_TOKEN"])
    for (const key of Object.keys(environment))
      if (key.toUpperCase() === secret) delete environment[key];
  const expanded = expandEnvironment(overrides, inherited);
  for (const [name, value] of Object.entries(expanded)) {
    if (platform === "win32")
      for (const key of Object.keys(environment))
        if (key.toUpperCase() === name.toUpperCase()) delete environment[key];
    environment[name] = value;
  }
  return environment;
}
