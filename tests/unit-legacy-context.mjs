/**
 * Pi 0.86+ passes providers a TranscriptContext whose system prompt and tools
 * live in `role: "system"` messages. toLegacyContext folds them back into
 * systemPrompt/tools so the rest of the bridge sees the pre-0.86 shape.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toLegacyContext } from "../src/convert.js";

const read = { name: "read", description: "Read", parameters: {} };
const bash = { name: "bash", description: "Bash", parameters: {} };
const user = { role: "user", content: "hi", timestamp: 1 };
const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 };

describe("toLegacyContext", () => {
	it("passes a legacy context through unchanged", () => {
		const ctx = { systemPrompt: "base", tools: [read], messages: [user] };
		assert.equal(toLegacyContext(ctx), ctx);
	});

	it("folds the leading system message into systemPrompt and tools", () => {
		const ctx = toLegacyContext({ messages: [{ role: "system", content: "base", toolsAdded: [read, bash], timestamp: 0 }, user] });
		assert.equal(ctx.systemPrompt, "base");
		assert.deepEqual(ctx.tools.map((t) => t.name), ["read", "bash"]);
		assert.deepEqual(ctx.messages, [user]);
	});

	it("accepts bare tool names in toolsRemoved", () => {
		const ctx = toLegacyContext({ messages: [
			{ role: "system", content: "base", toolsAdded: [read, bash], timestamp: 0 },
			{ role: "system", content: "", toolsRemoved: ["bash"], timestamp: 1 },
			user,
		] });
		assert.deepEqual(ctx.tools.map((t) => t.name), ["read"]);
	});

	it("replays mid-conversation prompt, section, and tool changes", () => {
		const ctx = toLegacyContext({ messages: [
			{ role: "system", content: "base", sections: { skills: "<skills>a</skills>" }, toolsAdded: [read, bash], timestamp: 0 },
			user,
			assistant,
			{ role: "system", content: [{ type: "text", text: "more" }], sections: { skills: "<skills>b</skills>" }, toolsRemoved: [{ name: "bash" }], timestamp: 3 },
			user,
		] });
		assert.equal(ctx.systemPrompt, "base\n\nmore\n\n<skills>b</skills>");
		assert.deepEqual(ctx.tools.map((t) => t.name), ["read"]);
		assert.deepEqual(ctx.messages.map((m) => m.role), ["user", "assistant", "user"]);
	});
});
