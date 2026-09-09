import { mock, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "bridge-handoff-"));
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
const { streamClaudeAgentSdk } = await import("../../src/index.ts");
const { ctx, resetStack, runWithSessionContext } = await import("../../src/query-state.ts");
const model = { api: "claude-bridge", provider: "claude-bridge", id: "claude-haiku-4-5", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const tools = [{ name: "bash", description: "test shell", parameters: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } } } }];
const user = text => ({ role: "user", content: text, timestamp: Date.now() });
const assistant = (...ids) => ({ type: "assistant", message: { content: ids.map(id => ({ type: "tool_use", id, name: "mcp__custom-tools__bash", input: { command: `echo ${id}`, timeout: 120 } })) } });
const result = (id, text) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: Date.now() });
const call = (sessionId, messages, signal) => streamClaudeAgentSdk(model, { messages, tools }, { sessionId, signal, cwd: scratch });
const tick = () => new Promise(resolve => setImmediate(resolve));
const handler = (q, id) => q.input.options.mcpServers["custom-tools"].tools[0].handler({ command: `echo ${id}`, timeout: 120 });
beforeEach(() => { resetStack(); queries.length = 0; });
afterEach(async () => { for (const q of queries) q.close(); await tick(); });
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

test("a nested child keeps its own query, tool results, and CLI session", { timeout: 5000 }, async () => {
  const p = [user("parent")], c = [user("child")];
  const parent = call("parent", p);
  const child = runWithSessionContext("parent", () => call("child", c));
  assert.equal(queries.length, 2, "child must start a query, not replace the parent's stream");
  queries[0].push({ type: "system", subtype: "init", session_id: "cli-parent" });
  queries[1].push({ type: "system", subtype: "init", session_id: "cli-child" });
  // Deliberately use identical tool IDs and arguments in the two queries.
  queries[0].push(assistant("shared-id")); queries[1].push(assistant("shared-id"));
  const pa = await parent.result(), ca = await child.result();
  const parentMcp = handler(queries[0], "shared-id"), childMcp = handler(queries[1], "shared-id");
  const childNext = call("child", [...c, ca, result("shared-id", "child output")]);
  assert.equal((await childMcp).content[0].text, "child output");
  const parentNext = call("parent", [...p, pa, result("shared-id", "parent output")]);
  assert.equal((await parentMcp).content[0].text, "parent output");
  queries[1].push({ type: "result", subtype: "success", result: "child done" }); queries[1].close();
  queries[0].push({ type: "result", subtype: "success", result: "parent done" }); queries[0].close();
  assert.equal((await childNext.result()).content[0].text, "child done");
  assert.equal((await parentNext.result()).content[0].text, "parent done");
  assert.equal(runWithSessionContext("parent", () => ctx().session.sessionId), "cli-parent");
  assert.equal(runWithSessionContext("child", () => ctx().session.sessionId), "cli-child");
});

test("late parallel calls reach Pi exactly once and their MCP handlers resolve", { timeout: 5000 }, async () => {
  const history = [user("parallel")];
  const first = call("parallel", history);
  const q = queries[0];
  q.push(assistant("first"));
  const a = await first.result();
  const executionIds = a.content.map(b => b.id);
  const firstMcp = handler(q, "first");
  // SDK emits further completed blocks while Pi executes its first snapshot.
  q.push(assistant("first", "second", "third")); await tick();
  const secondMcp = handler(q, "second"), thirdMcp = handler(q, "third");
  assert.deepEqual(executionIds, ["first"]);
  assert.deepEqual(a.content.map(b => b.id), ["first"], "published output is immutable");
  const nextHistory = [...history, a, result("first", "one")];
  const next = call("parallel", nextHistory);
  assert.equal((await firstMcp).content[0].text, "one");
  const b = await next.result();
  assert.deepEqual(b.content.map(b => b.id), ["second", "third"]);
  q.push(assistant("first", "second", "third")); await tick(); // duplicate SDK echo
  const last = call("parallel", [...nextHistory, b, result("third", "three"), result("second", "two")]);
  assert.equal((await secondMcp).content[0].text, "two");
  assert.equal((await thirdMcp).content[0].text, "three");
  q.push({ type: "result", subtype: "success", result: "done" }); q.close();
  assert.deepEqual((await last.result()).content.map(b => b.type), ["text"]);
  assert.equal(queries.length, 1);
});

test("aborting a child clears only its pending calls and leaves its parent running", { timeout: 5000 }, async () => {
  const abort = new AbortController();
  const p = [user("parent")];
  const parent = call("parent", p);
  const child = call("child", [user("child")], abort.signal);
  queries[0].push(assistant("p")); queries[1].push(assistant("c"));
  const pa = await parent.result(); await child.result();
  queries[1].push(assistant("c", "late")); await tick();
  const pending = handler(queries[1], "late");
  abort.abort();
  assert.equal((await pending).content[0].text, "Operation aborted");
  await tick();
  assert.equal(runWithSessionContext("child", () => ctx().pendingToolEmissions.size), 0);
  assert.equal(queries[0].closed, false);
  const parentMcp = handler(queries[0], "p");
  const next = call("parent", [...p, pa, result("p", "parent output")]);
  assert.equal((await parentMcp).content[0].text, "parent output");
  queries[0].push({ type: "result", subtype: "success", result: "parent finished" }); queries[0].close();
  assert.equal((await next.result()).content[0].text, "parent finished");
});

test("Pi's agent loop executes a late tool rather than only recording its ID", { timeout: 5000 }, async () => {
  const { Agent } = await import("@earendil-works/pi-agent-core");
  const executed = [];
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const agent = new Agent({ sessionId: "real-pi", streamFn: (m, c, o) => streamClaudeAgentSdk(m, c, { ...o, cwd: scratch }), initialState: {
    model, tools: [{ ...tools[0], label: "bash", execute: async (_id, args) => {
      executed.push(args.command);
      if (args.command === "echo first") await gate;
      return { content: [{ type: "text", text: args.command }], details: {} };
    } }],
  } });
  const running = agent.prompt("run the tools");
  await tick();
  const q = queries[0];
  q.push(assistant("first"));
  while (!executed.length) await tick();
  const firstMcp = handler(q, "first");
  q.push(assistant("first", "late")); await tick();
  const lateMcp = handler(q, "late");
  releaseFirst();
  assert.equal((await firstMcp).content[0].text, "echo first");
  assert.equal((await lateMcp).content[0].text, "echo late");
  q.push({ type: "result", subtype: "success", result: "all done" }); q.close();
  await running;
  assert.deepEqual(executed, ["echo first", "echo late"]);
  assert.equal(agent.state.messages.at(-1).content[0].text, "all done");
});

test("a prompt immediately after completion starts a fresh query in the same session", { timeout: 5000 }, async () => {
  const firstUser = user("first prompt");
  const first = call("sequential", [firstUser]);
  queries[0].push({ type: "result", subtype: "success", result: "first answer" }); queries[0].close();
  const answer = await first.result();
  const second = call("sequential", [firstUser, answer, user("second prompt")]);
  assert.equal(queries.length, 2);
  queries[1].push({ type: "result", subtype: "success", result: "second answer" }); queries[1].close();
  assert.equal((await second.result()).content.at(-1).text, "second answer");
});

test("child lifecycle events do not clear the parent's pointer or provider registration", async () => {
  const { default: register } = await import("../../src/index.ts");
  const key = Symbol.for("claude-bridge:activeStreamSimple");
  delete globalThis[key];
  const makePi = () => {
    const handlers = new Map();
    return { handlers, on: (name, fn) => handlers.set(name, fn), registerCommand() {}, registerProvider() {} };
  };
  const parentPi = makePi(), childPi = makePi();
  register(parentPi); register(childPi);
  const provider = globalThis[key];
  const host = id => ({ cwd: scratch, ui: { notify() {} }, sessionManager: { getSessionId: () => id } });
  await parentPi.handlers.get("session_start")({ reason: "startup" }, host("parent"));
  await childPi.handlers.get("session_start")({ reason: "startup" }, host("child"));
  runWithSessionContext("parent", () => { ctx().session = { sessionId: "cli-parent", cursor: 97, cwd: scratch }; });
  runWithSessionContext("child", () => { ctx().session = { sessionId: "cli-child", cursor: 3, cwd: scratch }; });
  await childPi.handlers.get("session_compact")({}, host("child"));
  assert.equal(runWithSessionContext("child", () => ctx().session.needsRebuild), true);
  assert.equal(runWithSessionContext("parent", () => ctx().session.needsRebuild), undefined);
  await childPi.handlers.get("session_shutdown")({}, host("child"));
  assert.equal(globalThis[key], provider);
  assert.equal(runWithSessionContext("parent", () => ctx().session.sessionId), "cli-parent");
  assert.equal(runWithSessionContext("child", () => ctx().session), null);
  delete globalThis[key];
});
