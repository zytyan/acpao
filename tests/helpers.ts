import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createApp, type AppOptions } from "../apps/server/src/app.js";
import type { TestContext } from "node:test";
export const project = process.cwd(),
  adminToken = "integration-admin-secret-123456789";
export async function setup(t: TestContext, options: AppOptions = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "acpao-test-"));
  const context = await createApp({
    dataDir: resolve(root, "center"),
    root,
    projectRoot: project,
    adminToken,
    demo: true,
    ...options,
  });
  await context.app.listen({ host: "127.0.0.1", port: 0 });
  const address = context.app.server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await context.app.close();
    await new Promise((r) => setTimeout(r, 80));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { ...context, root, url };
}
export async function until<T>(
  fn: () => T | Promise<T>,
  accept: (v: T) => boolean,
  timeout = 12000,
) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (accept(v)) return v;
    if (Date.now() > deadline) throw new Error(`condition timed out: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
export const owner = { kind: "admin" as const, id: "owner" };
