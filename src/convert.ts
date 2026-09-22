// Pure pi→Anthropic message conversion helpers.
// Extracted so they can be tested without pulling in the full extension runtime.

import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { ContentBlock, Message as SessionMessage } from "cc-session-io";
import { pascalCase } from "change-case";

export const PROVIDER_ID = "claude-bridge";

export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash",
};

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
	const existing = cache.get(id);
	if (existing) return existing;
	const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	cache.set(id, clean);
	return clean;
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
	return pascalCase(name);
}

export function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type !== "text" && block.type !== "image") { parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

function imageBlockToAnthropic(block: { data?: string; mimeType?: string }): ContentBlock | undefined {
	if (!block.data || !block.mimeType) return undefined;
	return { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } } as ContentBlock;
}

function toolResultContentToAnthropic(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string | ContentBlock[] {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const blocks: ContentBlock[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image") {
			const image = imageBlockToAnthropic(block);
			if (image) blocks.push(image);
		} else if (block.type) {
			blocks.push({ type: "text", text: `[${block.type}]` });
		}
	}
	if (blocks.length === 0) return "";
	if (blocks.every((block) => block.type === "text")) return blocks.map((block) => (block as { text: string }).text).join("\n");
	return blocks;
}

function assistantProvenancePrefix(msg: PiMessage): string | undefined {
	if (msg.role !== "assistant") return undefined;
	const provider = typeof (msg as any).provider === "string" ? (msg as any).provider : undefined;
	const model = typeof (msg as any).model === "string" ? (msg as any).model : undefined;
	const api = typeof (msg as any).api === "string" ? (msg as any).api : undefined;
	if (!provider && !model && !api) return undefined;
	if (provider === PROVIDER_ID || api === "anthropic") return undefined;
	return `[Prior Pi assistant response from ${provider ?? api ?? "unknown-provider"}${model ? `/${model}` : ""}]\n`;
}

function userMessageToAnthropic(msg: PiMessage): SessionMessage {
	if (typeof msg.content === "string") return { role: "user", content: msg.content || "[empty]" };
	if (Array.isArray(msg.content)) {
		const parts = [];
		for (const block of msg.content) {
			if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
			else if (block.type === "image" && block.data && block.mimeType) parts.push(imageBlockToAnthropic(block));
		}
		const kept = parts.filter(Boolean) as ContentBlock[];
		return { role: "user", content: kept.length ? kept : "[image]" };
	}
	return { role: "user", content: "[empty]" };
}

function toolResultToAnthropicBlock(msg: PiMessage, sanitizedIds: Map<string, string>): ContentBlock {
	const content = toolResultContentToAnthropic(msg.content as string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>);
	return {
		type: "tool_result",
		tool_use_id: sanitizeToolId((msg as { toolCallId: string }).toolCallId, sanitizedIds),
		content: content || "",
		is_error: (msg as { isError?: boolean }).isError,
	} as ContentBlock;
}

function hasToolUse(msg: PiMessage): boolean {
	return msg.role === "assistant" && Array.isArray(msg.content) && msg.content.some((block) => block.type === "toolCall");
}

/** Convert pi message array to Anthropic API format. */
export function convertPiMessages(
	messages: PiMessage[],
	customToolNameToSdk?: Map<string, string>,
): { anthropicMessages: SessionMessage[]; sanitizedIds: Map<string, string> } {
	const anthropicMessages = [];
	const sanitizedIds = new Map();

	const pushToolResultGroup = (toolMessages: PiMessage[]): void => {
		if (toolMessages.length === 0) return;
		anthropicMessages.push({
			role: "user",
			content: toolMessages.map((toolMsg) => {
				const content = toolResultContentToAnthropic(toolMsg.content as string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>);
				return {
					type: "tool_result",
					tool_use_id: sanitizeToolId((toolMsg as { toolCallId: string }).toolCallId, sanitizedIds),
					content: content || "",
					is_error: (toolMsg as { isError?: boolean }).isError,
				};
			}),
		});
	};

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "user") {
			anthropicMessages.push(userMessageToAnthropic(msg));
		} else if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? msg.content : [];
			const blocks = [];
			const provenance = assistantProvenancePrefix(msg);
			if (provenance) blocks.push({ type: "text", text: provenance });
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					const sig = block.thinkingSignature;
					const isAnthropicProvider = msg.provider === PROVIDER_ID || msg.api === "anthropic";
					if (isAnthropicProvider && sig) {
						blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
					}
				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({ type: "tool_use", id: sanitizeToolId(block.id, sanitizedIds), name: toolName, input: block.arguments ?? {} });
				}
			}
			if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
			anthropicMessages.push({ role: "assistant", content: blocks });

			// Pi may inject steer/followUp user messages between parallel tool
			// results, while runtime extraction treats every toolResult after the
			// assistant (until the next assistant) as one turn. Claude history must
			// put all tool_result blocks immediately after the tool_use assistant;
			// replay interleaved user text only after that grouped result message.
			if (hasToolUse(msg)) {
				const toolMessages: PiMessage[] = [];
				const interleavedUsers: PiMessage[] = [];
				let j = i + 1;
				for (; j < messages.length; j++) {
					const next = messages[j];
					if (next.role === "assistant") break;
					if (next.role === "toolResult") toolMessages.push(next);
					else if (next.role === "user") interleavedUsers.push(next);
					else break;
				}
				if (toolMessages.length > 0) {
					pushToolResultGroup(toolMessages);
					for (const userMsg of interleavedUsers) anthropicMessages.push(userMessageToAnthropic(userMsg));
					i = j - 1;
				}
			}
		} else if (msg.role === "toolResult") {
			const blocks: ContentBlock[] = [];
			for (; i < messages.length; i++) {
				const toolMsg = messages[i];
				if (toolMsg.role !== "toolResult") { i--; break; }
				blocks.push(toolResultToAnthropicBlock(toolMsg, sanitizedIds));
			}
			anthropicMessages.push({ role: "user", content: blocks });
		}
	}

	return { anthropicMessages, sanitizedIds };
}

type SystemLikeMessage = {
	role: "system";
	content?: string | Array<{ type: string; text?: string }>;
	sections?: Record<string, string | null>;
	toolsAdded?: Array<{ name: string; [key: string]: unknown }>;
	toolsRemoved?: Array<{ name: string } | string>;
};

type LegacyContextLike<TMessage, TTool> = {
	systemPrompt?: string;
	tools?: TTool[];
	messages: TMessage[];
};

/**
 * Pi 0.86+ hands providers a TranscriptContext: the system prompt and tool
 * declarations ride in `role: "system"` messages instead of `systemPrompt` and
 * `tools`. The bridge's session sync, tool-result extraction, and Claude history
 * rebuild all expect the older shape (no system messages), so replay the system
 * messages into `systemPrompt`/`tools` and drop them from `messages`. Older Pi
 * contexts carry no system messages and pass through unchanged.
 *
 * Mirrors pi-ai's getCurrentSystemPrompt/getCurrentTools; reimplemented here
 * because pi-ai releases before 0.86 do not export them.
 */
export function toLegacyContext<TContext extends LegacyContextLike<any, any>>(context: TContext): TContext {
	const messages = context.messages as Array<{ role: string }>;
	if (!messages.some((m) => m.role === "system")) return context;
	const content: string[] = [];
	const sections = new Map<string, string>();
	const tools = new Map<string, unknown>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		const system = message as SystemLikeMessage;
		const text = typeof system.content === "string"
			? system.content
			: (system.content ?? []).map((block) => (block.type === "text" ? block.text ?? "" : "")).join("");
		if (text.length > 0) content.push(text);
		for (const [name, value] of Object.entries(system.sections ?? {})) {
			if (value === null) sections.delete(name);
			else sections.set(name, value);
		}
		// pi-ai types removals as ToolReference ({ name }); accept bare names too.
		for (const tool of system.toolsRemoved ?? []) tools.delete(typeof tool === "string" ? tool : tool.name);
		for (const tool of system.toolsAdded ?? []) tools.set(tool.name, tool);
	}
	const promptParts = [content.join("\n\n"), ...sections.values()].filter((part) => part.length > 0);
	return {
		...context,
		systemPrompt: promptParts.join("\n\n"),
		tools: [...tools.values()],
		messages: messages.filter((m) => m.role !== "system"),
	};
}
