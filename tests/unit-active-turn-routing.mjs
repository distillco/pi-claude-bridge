import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ctx, resetStack, runWithSessionContext, forgetSessionContext } from "../src/query-state.ts";
beforeEach(() => resetStack());

test("callbacks rejoin their own session with parent and child both active", () => {
  let parent, child;
  runWithSessionContext("parent", () => {
    parent = ctx(); parent.activeQuery = {}; parent.session = { sessionId: "cli-parent", cursor: 97, cwd: "/same" };
    runWithSessionContext("child", () => { child = ctx(); child.activeQuery = {}; });
    assert.equal(ctx(), parent);
  });
  assert.notEqual(parent, child);
  assert.equal(runWithSessionContext("parent", () => ctx()), parent);
  assert.equal(runWithSessionContext("child", () => ctx()), child);
  assert.equal(child.session, null);
});

test("a sequential session in the same directory gets no previous CLI pointer", () => {
  runWithSessionContext("one", () => { ctx().session = { sessionId: "cli-one", cursor: 10, cwd: "/same" }; });
  assert.equal(runWithSessionContext("two", () => ctx().session), null);
  assert.equal(runWithSessionContext("one", () => ctx().session.sessionId), "cli-one");
});

test("older callers can use distinct turn signals without guessing from active queries", () => {
  const a = new AbortController(), b = new AbortController();
  const parent = runWithSessionContext(a.signal, () => ctx());
  assert.equal(runWithSessionContext(a.signal, () => ctx()), parent);
  assert.notEqual(runWithSessionContext(b.signal, () => ctx()), parent);
});

test("forgetting a child session preserves the parent's live state", () => {
  const parent = runWithSessionContext("parent", () => ctx());
  const child = runWithSessionContext("child", () => ctx());
  forgetSessionContext("child");
  assert.equal(runWithSessionContext("parent", () => ctx()), parent);
  assert.notEqual(runWithSessionContext("child", () => ctx()), child);
});
