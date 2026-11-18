export interface SlashCommand {
  name: string;
  description: string;
  inputHint?: string;
}

export function readSlashCommands(value: unknown): SlashCommand[] {
  if (!Array.isArray(value)) return [];
  const commands = new Map<string, SlashCommand>();
  for (const entry of value.slice(0, 256)) {
    if (!entry || typeof entry !== "object" || typeof entry.name !== "string") continue;
    const name = entry.name.trim().replace(/^\//, "");
    if (!name || name.length > 160 || /[\s\u0000-\u001f]/u.test(name)) continue;
    const hint = entry.input?.hint;
    commands.set(name, {
      name,
      description: typeof entry.description === "string" ? entry.description.slice(0, 500) : "",
      ...(typeof hint === "string" && hint ? { inputHint: hint.slice(0, 200) } : {}),
    });
  }
  return [...commands.values()];
}
