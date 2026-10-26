// Tool-result extraction: walks the context tail to collect this turn's
// tool results. Pi appends results to context and calls the provider again;
// this scrapes them back out. Walks past user messages (steer/followUp) that
// pi may inject between toolResults. Stops at the nearest assistant message
// (turn boundary).
// Extracted from index.ts so tests can import without activating the extension.

export type McpContent = Array<
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string }
>;

export interface McpResult {
	content: McpContent;
	isError?: boolean;
	toolCallId?: string;
	[key: string]: unknown;
}

export function toolResultToMcpContent(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): McpContent {
	if (typeof content === "string") return [{ type: "text", text: content || "" }];
	if (!Array.isArray(content)) return [{ type: "text", text: "" }];
	const blocks: McpContent = [];
	for (const block of content) {
		if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
		else if (block.type === "image" && block.data && block.mimeType) blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
	}
	return blocks.length ? blocks : [{ type: "text", text: "" }];
}

// Returns { results, stopIdx } so callers can log the walk boundary.
export function extractAllToolResults(
	messages: Array<{ role: string; content?: unknown; toolCallId?: string; isError?: boolean; [key: string]: unknown }>,
): { results: McpResult[]; stopIdx: number } {
	const results: McpResult[] = [];
	let stopIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "toolResult") {
			results.unshift({ content: toolResultToMcpContent(msg.content as string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>), isError: msg.isError, toolCallId: msg.toolCallId });
		} else if (msg.role === "assistant") { stopIdx = i; break; }
		// user messages: skip (steer/followUp injected mid-tool-execution)
	}
	return { results, stopIdx };
}

function userText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type?: string; text?: string }) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

// User messages Pi placed after this turn's assistant message, in order: steers
// delivered beside the tool results, or follow-ups. Pi may put one between
// parallel results, so the tail role says nothing. Messages before `fromIdx`
// were seen by an earlier provider call and are skipped.
export function extractInjectedUserMessages(
	messages: Array<{ role: string; content?: unknown; [key: string]: unknown }>,
	fromIdx = 0,
): string[] {
	const texts: string[] = [];
	for (let i = messages.length - 1; i >= Math.max(0, fromIdx); i--) {
		const msg = messages[i];
		if (msg.role === "assistant") break;
		if (msg.role === "user") {
			const text = userText(msg.content).trim();
			if (text) texts.unshift(text);
		}
	}
	return texts;
}

// Pi's context does not mark a user message as a steer or a follow-up, but its
// input event does. The bridge records steered input text and claims each
// record once when the message appears in context.
export function takeSteeredInput(steeredInputs: string[], text: string): boolean {
	const index = steeredInputs.indexOf(text.trim());
	if (index === -1) return false;
	steeredInputs.splice(index, 1);
	return true;
}

// The running Claude query cannot take a new user turn, but it is waiting for
// these tool results. Carrying the steered text inside the last one lets Claude
// read it on its next step instead of after the whole query ends.
export function withSteeredUserText(result: McpResult, text: string): McpResult {
	return {
		...result,
		content: [
			...result.content,
			{ type: "text", text: `\n\nThe user sent this message while the tool call ran. Read it before continuing:\n\n${text}` },
		],
	};
}
