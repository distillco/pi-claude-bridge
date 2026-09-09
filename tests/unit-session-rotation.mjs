/**
 * Tests for cross-task session rotation in syncSharedSession (DST-6144).
 *
 * The bridge keeps ONE process-global sharedSession pointer. When a different
 * pi session takes over the process (a new task: different cwd, shorter
 * history), the REUSE path must NOT hand it the previous task's CLI session.
 * Before the guards, `priorMessages.slice(cursor)` on a brand-new task's short
 * history returned [] — indistinguishable from "in sync" — and the new card
 * silently resumed the old card's conversation (observed cross-card bleed).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	__testGetBridgeIntegrityState,
	__testSetBridgeIntegrityState,
	__testSyncSharedSession,
} from "../src/index.js";

let root;
let taskACwd;
let taskBCwd;
let savedConfigDir;

const user = (text) => ({ role: "user", content: text });
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

describe("syncSharedSession cross-task rotation", () => {
	beforeEach(() => {
		root = mkdtempSync("/tmp/claude-bridge-rotation-");
		taskACwd = join(root, "worktree-a");
		taskBCwd = join(root, "worktree-b");
		mkdirSync(taskACwd, { recursive: true });
		mkdirSync(taskBCwd, { recursive: true });
		savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = join(root, "claude-config");
		__testSetBridgeIntegrityState({ sharedSession: null });
	});

	afterEach(() => {
		__testSetBridgeIntegrityState({ sharedSession: null });
		if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
		rmSync(root, { recursive: true, force: true });
	});

	it("a new task in a different cwd gets a clean start, not the old task's session", () => {
		__testSetBridgeIntegrityState({
			sharedSession: { sessionId: "aaaaaaaa-0000-0000-0000-000000000000", cursor: 12, cwd: taskACwd },
		});
		// Task B's very first turn: history is just the new user prompt.
		const result = __testSyncSharedSession([user("task B first prompt")], taskBCwd);
		assert.equal(result.sessionId, null, "must be a clean start, not a resume of task A's session");
	});

	it("a new pi session in the SAME cwd (history shorter than cursor) does not reuse", () => {
		__testSetBridgeIntegrityState({
			sharedSession: { sessionId: "aaaaaaaa-0000-0000-0000-000000000000", cursor: 12, cwd: taskACwd },
		});
		// Same cwd (e.g. daemon never chdir'd), but a brand-new conversation.
		const result = __testSyncSharedSession([user("new conversation")], taskACwd);
		assert.equal(result.sessionId, null, "shorter-than-cursor history must never look 'in sync'");
	});

	it("cwd-change rebuild rotates to a fresh sessionId instead of reusing the old task's UUID", () => {
		__testSetBridgeIntegrityState({
			sharedSession: { sessionId: "aaaaaaaa-0000-0000-0000-000000000000", cursor: 1, cwd: taskACwd },
		});
		// Task B resumes with existing history (e.g. daemon restart restored pi's
		// messages) — rebuild is expected, but under a NEW UUID in B's cwd.
		const result = __testSyncSharedSession(
			[user("task B prompt"), assistant("task B reply"), user("task B follow-up")],
			taskBCwd,
		);
		assert.ok(result.sessionId, "rebuild should produce a session");
		assert.notEqual(result.sessionId, "aaaaaaaa-0000-0000-0000-000000000000", "must not reuse task A's UUID");
		const { sharedSession } = __testGetBridgeIntegrityState();
		assert.equal(sharedSession.cwd, taskBCwd);
		assert.equal(sharedSession.cursor, 2);
	});

	it("same task, in-sync history still reuses (cache stays warm)", () => {
		__testSetBridgeIntegrityState({
			sharedSession: { sessionId: "bbbbbbbb-0000-0000-0000-000000000000", cursor: 2, cwd: taskACwd },
		});
		const result = __testSyncSharedSession(
			[user("prompt"), assistant("reply"), user("follow-up")],
			taskACwd,
		);
		assert.equal(result.sessionId, "bbbbbbbb-0000-0000-0000-000000000000");
	});

	it("same task, trailing-assistant drift still reuses and advances the cursor", () => {
		__testSetBridgeIntegrityState({
			sharedSession: { sessionId: "bbbbbbbb-0000-0000-0000-000000000000", cursor: 1, cwd: taskACwd },
		});
		const result = __testSyncSharedSession(
			[user("prompt"), assistant("reply"), user("follow-up")],
			taskACwd,
		);
		assert.equal(result.sessionId, "bbbbbbbb-0000-0000-0000-000000000000");
		assert.equal(__testGetBridgeIntegrityState().sharedSession.cursor, 2);
	});
});
