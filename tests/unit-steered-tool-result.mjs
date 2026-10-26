import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAllToolResults, extractInjectedUserMessages, takeSteeredInput, withSteeredUserText } from "../src/extract-tool-results.js";

const assistant = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] };
const result = (id, text) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }] });

describe("user messages injected into a tool-result turn", () => {
	it("finds a message after this turn's tool results", () => {
		const messages = [
			{ role: "user", content: "Fix the layout" },
			assistant,
			result("t1", "PASS a.test.ts"),
			{ role: "user", content: [{ type: "text", text: "also hide the box" }] },
		];
		assert.deepEqual(extractInjectedUserMessages(messages), ["also hide the box"]);
		assert.deepEqual(extractAllToolResults(messages).results.map((r) => r.toolCallId), ["t1"]);
	});

	it("finds a message between parallel results even when the tail is a result", () => {
		const messages = [
			{ role: "user", content: "earlier prompt" },
			assistant,
			result("t1", "one"),
			{ role: "user", content: "between" },
			result("t2", "two"),
		];
		assert.deepEqual(extractInjectedUserMessages(messages), ["between"]);
	});

	it("skips messages an earlier provider call already saw", () => {
		const messages = [
			{ role: "user", content: "go" },
			assistant,
			result("t1", "one"),
			{ role: "user", content: "seen" },
			result("t2", "two"),
			{ role: "user", content: "new" },
		];
		assert.deepEqual(extractInjectedUserMessages(messages, 4), ["new"]);
	});

	it("returns nothing for an ordinary tool-result turn", () => {
		assert.deepEqual(extractInjectedUserMessages([{ role: "user", content: "go" }, assistant, result("t1", "ok")]), []);
	});
});

describe("steered input records", () => {
	it("claims a recorded steer once and leaves follow-ups unclaimed", () => {
		const steered = ["also hide the box"];
		assert.equal(takeSteeredInput(steered, "a follow-up"), false);
		assert.equal(takeSteeredInput(steered, "also hide the box"), true);
		assert.equal(takeSteeredInput(steered, "also hide the box"), false);
	});
});

describe("carrying a steer on a tool result", () => {
	it("appends the message after the tool's own output, without mutating it", () => {
		const original = { toolCallId: "t1", content: [{ type: "text", text: "PASS a.test.ts" }] };
		const carried = withSteeredUserText(original, "also hide the box");
		assert.equal(original.content.length, 1);
		assert.equal(carried.toolCallId, "t1");
		assert.equal(carried.content[0].text, "PASS a.test.ts");
		assert.match(carried.content[1].text, /The user sent this message while the tool call ran[\s\S]*also hide the box$/);
	});
});
