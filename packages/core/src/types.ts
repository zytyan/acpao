import { z } from "zod";
export const AgentSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().min(1).max(100),
  command: z.string().min(1).max(2000),
  args: z.array(z.string()).max(50).default([]),
  env: z.record(z.string(), z.string()).default({}),
});
export type AgentConfig = z.infer<typeof AgentSchema>;
export const CreateSchema = z.object({
  host: z.string().default("local"),
  agent: z.string().optional(),
  cwd: z.string().min(1).max(4096),
  title: z.string().min(1).max(120).default("新的工作"),
  main: z.boolean().default(false),
  isolate: z.boolean().default(false),
});
export const SendSchema = z.object({
  session: z.string(),
  text: z.string().min(1).max(100_000),
  mode: z.enum(["auto", "queue", "steer", "immediate"]).default("auto"),
  requestId: z.string().min(8).max(128).optional(),
});
export type SessionStatus =
  | "creating"
  | "idle"
  | "running"
  | "waiting_permission"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "interrupted"
  | "error"
  | "closed";
export interface Session {
  id: string;
  host: string;
  agent: string;
  cwd: string;
  title: string;
  status: SessionStatus;
  acpId?: string;
  processId?: number;
  capabilities?: { load: boolean; steering: boolean };
  parent?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  stopReason?: string;
}
export interface Host {
  id: string;
  name: string;
  kind: "local" | "remote";
  status: "online" | "offline" | "revoked";
  agents: AgentConfig[];
  cwd: string;
  platform?: string;
  manageAgents?: boolean;
  browseDirectories?: boolean;
  gatewayArch?: string;
  gatewayVersion?: string;
  gatewayManaged?: boolean;
  lastSeen?: number;
  error?: string;
}
export interface Message {
  id: number;
  session: string;
  role: "user" | "assistant" | "tool" | "system";
  body: string;
  run: string;
  createdAt: number;
}
export interface Event {
  seq: number;
  session: string;
  kind: string;
  data: unknown;
  createdAt: number;
}
export interface Command {
  id: string;
  session: string;
  text: string;
  status: "queued" | "steering" | "running" | "completed" | "cancelled" | "failed" | "interrupted";
  createdAt: number;
}
export interface Approval {
  id: string;
  session: string;
  request: unknown;
  status: "pending" | "approved" | "denied" | "cancelled";
  createdAt: number;
}
export interface Principal {
  kind: "admin" | "agent" | "device";
  id: string;
  session?: string;
  host?: string;
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const terminal = new Set<SessionStatus>([
  "completed",
  "cancelled",
  "interrupted",
  "error",
  "closed",
]);
export function publicHost(h: Host) {
  return {
    ...h,
    agents: h.agents.map((a) => ({ id: a.id, name: a.name })),
    capabilities: {
      steering: false,
      processStrategy: "isolated",
      worktree: true,
    },
  };
}
