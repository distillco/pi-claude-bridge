import { test } from "node:test";
import assert from "node:assert";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { TOOL_PROGRESS_CHANNEL, publishToolProgress } from "../src/tool-progress.js";

function message(overrides = {}) {
	return {
		type: "tool_progress",
		tool_use_id: "toolu_123",
		tool_name: "mcp__custom-tools__grep",
		parent_tool_use_id: null,
		elapsed_time_seconds: 30,
		uuid: "uuid-1",
		session_id: "session-1",
		...overrides,
	};
}

test("publishes normalized tool progress without a Pi assistant stream", () => {
	const received = [];
	const listener = (payload) => received.push(payload);
	subscribe(TOOL_PROGRESS_CHANNEL, listener);
	try {
		const published = publishToolProgress(
			message(),
			new Map([["mcp__custom-tools__grep", "grep"]]),
		);
		assert.deepEqual(published, {
			toolUseId: "toolu_123",
			toolName: "grep",
			elapsedSeconds: 30,
		});
		assert.deepEqual(received, [published]);
	} finally {
		unsubscribe(TOOL_PROGRESS_CHANNEL, listener);
	}
});

test("normalizes tool names case-insensitively and preserves parent ids", () => {
	const published = publishToolProgress(
		message({
			tool_name: "MCP__CUSTOM-TOOLS__GREP",
			parent_tool_use_id: "toolu_parent",
			elapsed_time_seconds: 12.5,
		}),
		new Map([["mcp__custom-tools__grep", "grep"]]),
	);
	assert.deepEqual(published, {
		toolUseId: "toolu_123",
		toolName: "grep",
		elapsedSeconds: 12.5,
		parentToolUseId: "toolu_parent",
	});
});

test("ignores malformed progress instead of publishing it", () => {
	for (const malformed of [
		message({ tool_use_id: "" }),
		message({ tool_name: "" }),
		message({ elapsed_time_seconds: -1 }),
		message({ elapsed_time_seconds: Number.NaN }),
	]) {
		assert.equal(publishToolProgress(malformed, new Map()), null);
	}
});
