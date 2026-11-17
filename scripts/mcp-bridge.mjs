// ACP agents launch this stdio MCP bridge. Credentials never enter command arguments.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const base = process.env.ACPAO_CENTER,
  token = process.env.ACPAO_TOKEN;
if (!base || !token) process.exit(1);
const request = async (path, body) => {
  const r = await fetch(new URL(path, base), {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(40000),
  });
  const data = await r.json();
  if (!r.ok)
    throw Object.assign(new Error(data.error?.message ?? `ACPAO request failed (${r.status})`), {
      code: data.error?.code ?? "REQUEST_FAILED",
    });
  return data;
};
const server = new Server({ name: "acpao", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => request("/api/tool-schema"));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const r = await request(
      `/api/tools/${encodeURIComponent(params.name)}`,
      params.arguments ?? {},
    );
    return { content: [{ type: "text", text: JSON.stringify(r) }] };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ code: e.code ?? "CONNECTION_FAILED", message: e.message }),
        },
      ],
    };
  }
});
await server.connect(new StdioServerTransport());
