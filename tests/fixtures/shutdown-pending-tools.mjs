import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "bridge-shutdown-"));
process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude");
process.env.CLAUDE_BRIDGE_DIAG_PATH = join(scratch, "diag.log");
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(scratch, "debug.log");
process.env.CLAUDE_BRIDGE_CLI_DEBUG_DIR = join(scratch, "cli");
const queries = [];
class Query {
  messages = [];
  waiting;
  closed = false;
  constructor(input) { this.input = input; }
  push(message) {
    if (this.waiting) { const resolve = this.waiting; this.waiting = undefined; resolve({ value: message, done: false }); }
    else this.messages.push(message);
  }
  next() {
    if (this.messages.length) return Promise.resolve({ value: this.messages.shift(), done: false });
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise(resolve => { this.waiting = resolve; });
  }
  [Symbol.asyncIterator]() { return this; }
  close() { this.closed = true; this.waiting?.({ done: true }); this.waiting = undefined; }
  async interrupt() { this.close(); }
}
mock.module("@anthropic-ai/claude-agent-sdk", { namedExports: {
  createSdkMcpServer: config => config,
  query: input => { const q = new Query(input); queries.push(q); return q; },
} });
const { default: register, streamClaudeAgentSdk } = await import("../../src/index.ts");
const { ctx, runWithSessionContext } = await import("../../src/query-state.ts");
const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-haiku-4-5", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const tools = [{ name: "bash", description: "test shell", parameters: { type: "object", properties: { command: { type: "string" } } } }];
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

test("session_shutdown answers a held tool call with an error and ends the query", { timeout: 5000 }, async () => {
  const handlers = new Map();
  register({ on: (name, fn) => handlers.set(name, fn), registerCommand() {}, registerProvider() {} });
  const host = { cwd: scratch, ui: { notify() {} }, sessionManager: { getSessionId: () => "shutdown" } };
  await handlers.get("session_start")({ reason: "startup" }, host);

  const turn = streamClaudeAgentSdk(model, { messages: [{ role: "user", content: "run it", timestamp: Date.now() }], tools }, { sessionId: "shutdown", cwd: scratch });
  const q = queries[0];
  q.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "held", name: "mcp__custom-tools__bash", input: { command: "echo held" } }] } });
  await turn.result();
  const held = q.input.options.mcpServers["custom-tools"].tools[0].handler({ command: "echo held" });
  const queryCtx = runWithSessionContext("shutdown", () => ctx());
  assert.equal(queryCtx.pendingToolCalls.size, 1);

  await handlers.get("session_shutdown")({}, host);

  assert.deepEqual(await held, { content: [{ type: "text", text: "Session shut down" }], isError: true });
  assert.equal(queryCtx.pendingToolCalls.size, 0);
  assert.equal(queryCtx.pendingResults.size, 0);
  assert.equal(queryCtx.pendingToolEmissions.size, 0);
  assert.equal(queryCtx.activeQuery, null);
  assert.equal(q.closed, true, "shutdown must end the SDK query");
  delete globalThis[Symbol.for("claude-bridge:activeStreamSimple")];
});
