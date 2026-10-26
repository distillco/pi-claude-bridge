import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAllToolResults, extractSteeredUserText, withSteeredUserText } from "../src/extract-tool-results.js";

const assistant = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] };
const result = (id, text) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }] });

describe("steered user messages in a tool-result turn", () => {
	it("finds the user message Pi steered in after this turn's tool results", () => {
		const messages = [
			{ role: "user", content: "Fix the layout" },
			assistant,
			result("t1", "PASS a.test.ts"),
			{ role: "user", content: [{ type: "text", text: "also hide the box" }] },
		];
		assert.equal(extractSteeredUserText(messages), "also hide the box");
		// The tool results are still extracted past the steered message.
		assert.deepEqual(extractAllToolResults(messages).results.map((r) => r.toolCallId), ["t1"]);
	});

	it("joins messages steered between parallel results, and ignores earlier turns", () => {
		const messages = [
			{ role: "user", content: "earlier prompt" },
			assistant,
			result("t1", "one"),
			{ role: "user", content: "first" },
			result("t2", "two"),
			{ role: "user", content: "second" },
		];
		assert.equal(extractSteeredUserText(messages), "first\n\nsecond");
	});

	it("returns null for an ordinary tool-result turn", () => {
		assert.equal(extractSteeredUserText([{ role: "user", content: "go" }, assistant, result("t1", "ok")]), null);
	});

	it("carries the message after the tool's own output, without mutating it", () => {
		const original = { toolCallId: "t1", content: [{ type: "text", text: "PASS a.test.ts" }] };
		const carried = withSteeredUserText(original, "also hide the box");
		assert.equal(original.content.length, 1);
		assert.equal(carried.toolCallId, "t1");
		assert.equal(carried.content[0].text, "PASS a.test.ts");
		assert.match(carried.content[1].text, /The user sent this message while the tool call ran[\s\S]*also hide the box$/);
	});
});
