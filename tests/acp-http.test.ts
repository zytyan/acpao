import test from "node:test";
import assert from "node:assert/strict";
import * as acp from "@agentclientprotocol/sdk";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { setup, adminToken } from "./helpers.js";

test("authenticated ACP Streamable HTTP creates a real Session and streams its output", async (t) => {
  const c = await setup(t);
  const anonymous = await fetch(c.url + "/acp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  assert.equal(anonymous.status, 401);
  const chunks: string[] = [];
  const connection = acp
    .client({ name: "HTTP integration client" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (
        params.update.sessionUpdate === "agent_message_chunk" &&
        params.update.content.type === "text"
      )
        chunks.push(params.update.content.text);
    })
    .connect(
      createHttpStream(c.url + "/acp", { headers: { Authorization: `Bearer ${adminToken}` } }),
    );
  try {
    const init = await connection.agent.request(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
      { cancellationSignal: AbortSignal.timeout(10000), stopWaitingOnCancel: true },
    );
    assert.equal(init.protocolVersion, acp.PROTOCOL_VERSION);
    const created = await connection.agent.request(acp.methods.agent.session.new, {
      cwd: c.root,
      mcpServers: [],
    });
    assert.ok(created.sessionId.startsWith("s_"));
    const result = await connection.agent.request(
      acp.methods.agent.session.prompt,
      {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "via ACP HTTP" }],
      },
      { cancellationSignal: AbortSignal.timeout(12000), stopWaitingOnCancel: true },
    );
    assert.equal(result.stopReason, "end_turn");
    assert.match(chunks.join(""), /via ACP HTTP/);
    assert.equal(c.store.session(created.sessionId).status, "completed");
  } finally {
    await connection.close();
  }
});
