export interface Agent {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}
export interface Host {
  id: string;
  name: string;
  kind: "local" | "remote";
  status: "online" | "offline" | "revoked";
  agents: Agent[];
  cwd: string;
  platform?: string;
  error?: string;
}
export interface Session {
  id: string;
  host: string;
  agent: string;
  title: string;
  cwd: string;
  status: string;
  updatedAt: number;
  error?: string;
  capabilities?: { load: boolean };
  parent?: string;
}
export interface Message {
  id: number;
  session: string;
  role: "user" | "assistant" | "tool" | "system";
  body: string;
  run: string;
  createdAt: number;
}
export interface Approval {
  id: string;
  session: string;
  request: {
    toolCall: { title?: string; rawInput?: unknown };
    options: { optionId: string; name: string; kind: string }[];
  };
}
export interface ChatData {
  session: Session;
  messages: Message[];
  approvals: Approval[];
  delegations: {
    session: string;
    title: string;
    status: string;
    agent: string;
  }[];
  queued?: number;
}
export interface Diagnostic {
  id: number;
  createdAt: number;
  level: "info" | "warning" | "error";
  source: string;
  code: string;
  message: string;
  session?: string;
  agent?: string;
}
export interface DiagnosticData {
  logs: Diagnostic[];
  retentionDays: number;
  testFeatures: boolean;
}
export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message ?? `请求失败 (${r.status})`);
  return data as T;
}
export const statusName: Record<string, string> = {
  creating: "正在连接",
  idle: "就绪",
  running: "正在工作",
  waiting_permission: "等待你的确认",
  cancelling: "正在取消",
  completed: "已完成",
  cancelled: "已取消",
  interrupted: "已中断",
  error: "需要处理",
  closed: "已关闭",
};
export const busy = (s?: string) =>
  ["running", "waiting_permission", "cancelling", "creating"].includes(s ?? "");
