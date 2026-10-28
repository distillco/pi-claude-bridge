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

// Starts a turn whose first query ends with a deferred message queued, so the
// bridge replays it as a continuation query. The first query streams text, so
// its turn has started and its idle watchdog is disarmed when the continuation runs.
async function startContinuation(sessionId, signal) {
  const handlers = new Map();
  register({ on: (name, fn) => handlers.set(name, fn), registerCommand() {}, registerProvider() {} });
  const host = { cwd: scratch, ui: { notify() {} }, sessionManager: { getSessionId: () => sessionId } };
  await handlers.get("session_start")({ reason: "startup" }, host);

  const turn = streamClaudeAgentSdk(model, { messages: [{ role: "user", content: "start", timestamp: Date.now() }], tools }, { sessionId, cwd: scratch, signal });
  const first = queries.at(-1);
  const queryCtx = runWithSessionContext(sessionId, () => ctx());
  first.push({ type: "system", subtype: "init", session_id: `${sessionId}-session` });
  first.push({ type: "assistant", message: { content: [{ type: "text", text: "first answer" }] } });
  // A message after the turn started disarms the idle watchdog, as the SDK's
  // closing messages do in a real query.
  first.push({ type: "system", subtype: "status" });
  queryCtx.deferredUserMessages.push("follow up");
  first.close();
  while (queries.at(-1) === first) await new Promise(resolve => setImmediate(resolve));
  const cont = queries.at(-1);
  assert.equal(cont.input.prompt, "follow up");
  return { handlers, host, turn, cont, queryCtx };
}

test("session_shutdown ends a deferred-message continuation query", { timeout: 5000 }, async () => {
  const { handlers, host, turn, cont, queryCtx } = await startContinuation("continuation");
  cont.push({ type: "assistant", message: { content: [{ type: "tool_use", id: "held-cont", name: "mcp__custom-tools__bash", input: { command: "echo cont" } }] } });
  await turn.result();
  const held = cont.input.options.mcpServers["custom-tools"].tools[0].handler({ command: "echo cont" });
  assert.equal(queryCtx.pendingToolCalls.size, 1);

  await handlers.get("session_shutdown")({}, host);

  assert.deepEqual(await held, { content: [{ type: "text", text: "Session shut down" }], isError: true });
  assert.equal(cont.closed, true, "shutdown must end the continuation query");
  delete globalThis[Symbol.for("claude-bridge:activeStreamSimple")];
});

test("an abort during a continuation ends the Pi stream as aborted", { timeout: 5000 }, async () => {
  const controller = new AbortController();
  const { turn, cont } = await startContinuation("continuation-abort", controller.signal);

  controller.abort();

  const result = await turn.result();
  assert.equal(result.stopReason, "aborted");
  assert.equal(result.errorMessage, "Operation aborted");
  assert.equal(cont.closed, true, "abort must end the continuation query");
  delete globalThis[Symbol.for("claude-bridge:activeStreamSimple")];
});

test("the stream idle watchdog times out a continuation that sends nothing", { timeout: 5000 }, async () => {
  const previousTimeout = process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
  process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = "50ms";
  let started;
  try { started = await startContinuation("continuation-idle"); }
  finally {
    if (previousTimeout === undefined) delete process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT;
    else process.env.CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT = previousTimeout;
  }

  // The watchdog's timer is unref'd, so hold the event loop open until it fires.
  const keepAlive = setTimeout(() => {}, 5000);
  const result = await started.turn.result();
  clearTimeout(keepAlive);
  assert.equal(result.stopReason, "error");
  assert.equal(result.rateLimitType, "stream_idle");
  assert.equal(started.cont.closed, true, "the timeout must end the continuation query");
  delete globalThis[Symbol.for("claude-bridge:activeStreamSimple")];
});
