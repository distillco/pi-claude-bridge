import { channel } from "node:diagnostics_channel";
import type { SDKToolProgressMessage } from "@anthropic-ai/claude-agent-sdk";

export const TOOL_PROGRESS_CHANNEL = "pi-claude-bridge:tool-progress";

export interface ClaudeBridgeToolProgress {
	toolUseId: string;
	toolName: string;
	elapsedSeconds: number;
	parentToolUseId?: string;
}

const progressChannel = channel(TOOL_PROGRESS_CHANNEL);

/**
 * Publish Claude SDK tool progress outside Pi's assistant stream.
 *
 * Tool progress arrives while Pi is executing the tool and the bridge has ended
 * its current assistant stream, so trying to encode this as a Pi stream event
 * drops it. diagnostics_channel provides a process-local liveness signal without
 * mutating conversation history or transcript output.
 */
export function publishToolProgress(
	message: SDKToolProgressMessage,
	customToolNameToPi: ReadonlyMap<string, string>,
): ClaudeBridgeToolProgress | null {
	if (!message.tool_use_id || !message.tool_name) return null;
	if (!Number.isFinite(message.elapsed_time_seconds) || message.elapsed_time_seconds < 0) return null;

	const toolName = customToolNameToPi.get(message.tool_name)
		?? customToolNameToPi.get(message.tool_name.toLowerCase())
		?? message.tool_name;
	const progress: ClaudeBridgeToolProgress = {
		toolUseId: message.tool_use_id,
		toolName,
		elapsedSeconds: message.elapsed_time_seconds,
		...(message.parent_tool_use_id ? { parentToolUseId: message.parent_tool_use_id } : {}),
	};
	progressChannel.publish(progress);
	return progress;
}
