/**
 * Claude Code sends a tool-use message's real output count after the MCP call
 * returns, when the bridge has already closed that Pi message. The SDK result
 * carries the query's output; reconcileQueryOutput puts the shortfall on the
 * open message so the session total matches Claude Code's.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { processAssistantMessage, processStreamEvent, reconcileQueryOutput } from "../src/index.ts";
import { ctx, resetStack } from "../src/query-state.ts";

const model = {
	api: "claude-bridge",
	provider: "claude-bridge",
	id: "claude-sonnet-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const toolNames = new Map([["mcp__custom-tools__read", "read"]]);

function installFakeStream() {
	const events = [];
	ctx().currentPiStream = {
		push(event) { events.push(event); },
		end(result) { events.push({ type: "stream_end", result }); },
	};
	return events;
}

function messageStart(output) {
	processStreamEvent({
		type: "stream_event",
		event: { type: "message_start", message: { model: model.id, usage: { input_tokens: 10, output_tokens: output } } },
	}, toolNames, model);
}

function assistant(content) {
	processAssistantMessage({
		type: "assistant",
		message: { model: model.id, content, usage: { input_tokens: 10, output_tokens: 4 } },
	}, model, toolNames);
}

function result(outputTokens, modelUsage = { [model.id]: { outputTokens } }) {
	return { type: "result", subtype: "success", result: "done", usage: { output_tokens: outputTokens }, modelUsage };
}

/** One query: a tool-use message Pi consumes, then a text message left open.
 * Returns the closed message's output so callers can sum the Pi messages. */
function runToolThenTextQuery() {
	const c = ctx();
	installFakeStream();
	messageStart(4);
	c.turnSawStreamEvent = true;
	assistant([{ type: "tool_use", id: "toolu_1", name: "mcp__custom-tools__read", input: { file_path: "a.txt" } }]);
	assert.equal(c.currentPiStream, null, "tool-use assistant message closes the Pi stream");
	const closedOutput = c.turnOutput.usage.output;

	// Tool-result delivery: a fresh Pi message on a new stream.
	c.resetTurnState(model);
	installFakeStream();
	messageStart(4);
	assistant([{ type: "text", text: "All done." }]);
	return closedOutput;
}

describe("reconcileQueryOutput", () => {
	beforeEach(() => {
		resetStack();
		ctx().resetTurnState(model);
	});

	it("puts the query's missing output on the open message", () => {
		const closedOutput = runToolThenTextQuery();

		reconcileQueryOutput(result(4300), model);

		const c = ctx();
		assert.equal(c.turnOutput.usage.output, 4296);
		assert.equal(closedOutput + c.turnOutput.usage.output, 4300);
		assert.equal(c.turnOutput.usage.totalTokens, 10 + 4296);
	});

	it("reads the per-query usage, not modelUsage, which is cumulative on a resumed session and lists side models", () => {
		const closedOutput = runToolThenTextQuery();

		reconcileQueryOutput(result(4300, {
			[model.id]: { outputTokens: 9100 },
			"claude-haiku-4-5-20251001": { outputTokens: 700 },
		}), model);

		assert.equal(closedOutput + ctx().turnOutput.usage.output, 4300);
	});

	it("leaves usage alone when no result arrives", () => {
		runToolThenTextQuery();
		assert.equal(ctx().turnOutput.usage.output, 4);
	});

	it("never lowers the open message's output", () => {
		runToolThenTextQuery();
		reconcileQueryOutput(result(0), model);
		assert.equal(ctx().turnOutput.usage.output, 4);
	});

	it("carries the main query's reconciled output into a continuation on the same Pi stream", () => {
		const closedOutput = runToolThenTextQuery();
		reconcileQueryOutput(result(4300), model);

		// Continuation loop: same stream, fresh turnOutput, sum starts at minus the carried output.
		const c = ctx();
		const carriedOutput = c.turnOutput.usage.output;
		c.resetTurnState(model);
		c.resetToolTracking();
		c.closedOutputTokens = -carriedOutput;
		messageStart(3);
		assistant([{ type: "text", text: "Wrapping up." }]);
		reconcileQueryOutput(result(50), model);

		assert.equal(c.turnOutput.usage.output, carriedOutput + 50);
		assert.equal(closedOutput + c.turnOutput.usage.output, 4300 + 50);
	});
});
