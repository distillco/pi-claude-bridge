// Query state: QueryContext class + context stack.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// (subagents) push the parent context onto a stack and get a fresh instance.
// Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.
// Provider entry points select a session store; the legacy stack helpers remain
// for direct callers, and are not used to route parent/child provider calls.

import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { McpResult } from "./extract-tool-results.js";

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export interface TurnToolCallRecord {
	id: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

export interface ClaimedToolCall {
	toolCallId?: string;
	match: "tool-args" | "tool-name" | "none";
	ambiguous: boolean;
	available: number;
}

export interface ToolResultProgress {
	expectedIds: string[];
	deliveredIds: string[];
	resolvedIds: string[];
	waitingIds: string[];
	queuedIds: string[];
	unmatchedResultIds: string[];
	missingDeliveredIds: string[];
	unresolvedIds: string[];
	toolNames: Array<{ name: string; count: number }>;
	expectedCount: number;
	deliveredCount: number;
	resolvedCount: number;
	waitingCount: number;
	queuedCount: number;
	unmatchedResultCount: number;
}

function normalizeForCompare(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeForCompare);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key];
			if (child !== undefined) out[key] = normalizeForCompare(child);
		}
		return out;
	}
	return value;
}

function argsKey(value: unknown): string {
	return JSON.stringify(normalizeForCompare(value ?? {}));
}

function sameArgs(left: unknown, right: unknown): boolean {
	return argsKey(left) === argsKey(right);
}

function hasRecordedArgs(args: Record<string, unknown> | undefined): boolean {
	return Object.keys(args ?? {}).length > 0;
}

function unique(values: Iterable<string | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

export interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY after an abort. The killed CC subprocess may still be flushing
	// a late "[Request interrupted by user]" record to the session JSONL.
	// Reusing the same sessionId/path would race that orphan write into our
	// fresh file and break CC's parent-uuid chain on the next resume. When
	// this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. Compact/tree do NOT set
	// this — there's no concurrent CC writer during those events, so
	// in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
}

export class QueryContext {
  // Session state belongs to the Pi conversation, including nested Agent sessions.
  session: SessionState | null = null;
  extensionApi: ExtensionAPI | undefined;
  piUI: ExtensionUIContext | undefined;
  emittedToolCallIds = new Set<string>();
  pendingToolEmissions = new Map<string, TurnToolCallRecord>();
	// Query-scoped (fully isolated per query)
	activeQuery: unknown | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	latestCursor = 0;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	turnToolCallIds: string[] = [];
	turnToolCalls: TurnToolCallRecord[] = [];
	claimedToolCallIds = new Set<string>();
	deliveredToolResultIds = new Set<string>();
	resolvedToolResultIds = new Set<string>();
	unmatchedToolResultIds = new Set<string>();
	reportedToolResultMismatch = false;
	deferredUserMessages: string[] = [];
	handledTerminalError = false;

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;

	get turnBlocks(): Array<any> {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	resetTurnState(model: Model<any>): void {
		this.turnOutput = {
			role: "assistant", content: [],
			api: model.api, provider: model.provider, model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop", timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		this.handledTerminalError = false;
		// Tool-call tracking is NOT reset here — it persists across the
		// tool-result delivery callback for the same assistant message. New
		// assistant messages call resetToolTracking() explicitly.
	}

	resetToolTracking(): void {
		this.turnToolCallIds = [];
		this.turnToolCalls = [];
		this.claimedToolCallIds.clear();
		this.deliveredToolResultIds.clear();
		this.resolvedToolResultIds.clear();
		this.unmatchedToolResultIds.clear();
		this.reportedToolResultMismatch = false;
	}

	recordToolCall(id: string | undefined, toolName: string, args: Record<string, unknown> = {}): void {
		if (!id) return;
		if (!this.turnToolCallIds.includes(id)) this.turnToolCallIds.push(id);
		const existing = this.turnToolCalls.find((call) => call.id === id);
		if (existing) {
			existing.toolName = toolName;
			existing.arguments = args;
			return;
		}
		this.turnToolCalls.push({ id, toolName, arguments: args });
	}

	updateToolCallArgs(id: string | undefined, args: Record<string, unknown>): void {
		if (!id) return;
		const existing = this.turnToolCalls.find((call) => call.id === id);
		if (existing) existing.arguments = args;
	}

	hasRecordedToolCall(id: string | undefined): boolean {
		return Boolean(id && (this.turnToolCallIds.includes(id) || this.turnToolCalls.some((call) => call.id === id)));
	}

	claimToolCall(toolName: string, args: Record<string, unknown> = {}): ClaimedToolCall {
		const unclaimed = this.turnToolCalls.filter((call) => !this.claimedToolCallIds.has(call.id));
		const byName = unclaimed.filter((call) => call.toolName === toolName);
		const exact = byName.filter((call) => sameArgs(call.arguments, args));
		let chosen: TurnToolCallRecord | undefined;
		let match: ClaimedToolCall["match"] = "none";
		let ambiguous = false;

		if (exact.length > 0) {
			chosen = exact[0];
			match = "tool-args";
			ambiguous = exact.length > 1;
		} else if (byName.length === 1 && !hasRecordedArgs(byName[0].arguments)) {
			// The SDK can invoke the MCP handler after content_block_start but
			// before input_json_delta/content_block_stop finalizes arguments.
			// Falling back to the sole same-name, argument-less call preserves that
			// race without ever claiming a different tool type.
			chosen = byName[0];
			match = "tool-name";
		}

		if (!chosen) return { match: "none", ambiguous: false, available: unclaimed.length };
		this.claimedToolCallIds.add(chosen.id);
		return { toolCallId: chosen.id, match, ambiguous, available: unclaimed.length };
	}

	markToolResultDelivered(id: string | undefined): void {
		if (id) this.deliveredToolResultIds.add(id);
	}

	markToolResultResolved(id: string | undefined): void {
		if (id) this.resolvedToolResultIds.add(id);
	}

	markToolResultUnmatched(id: string | undefined): void {
		if (id) this.unmatchedToolResultIds.add(id);
	}

	toolResultProgress(): ToolResultProgress {
		const expectedIds = unique([
			...this.turnToolCalls.map((call) => call.id),
			...this.turnToolCallIds,
		]);
		const deliveredIds = unique(this.deliveredToolResultIds);
		const resolvedIds = unique(this.resolvedToolResultIds);
		const waitingIds = unique(this.pendingToolCalls.keys());
		const queuedIds = unique(this.pendingResults.keys());
		const unmatchedResultIds = unique(this.unmatchedToolResultIds);
		const missingDeliveredIds = expectedIds.filter((id) => !this.deliveredToolResultIds.has(id));
		const unresolvedIds = expectedIds.filter((id) => !this.resolvedToolResultIds.has(id));
		const affectedIds = new Set([...missingDeliveredIds, ...unresolvedIds, ...waitingIds, ...queuedIds, ...unmatchedResultIds]);
		const counts = new Map<string, number>();
		for (const call of this.turnToolCalls) {
			if (affectedIds.size > 0 && !affectedIds.has(call.id)) continue;
			counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
		}
		return {
			expectedIds,
			deliveredIds,
			resolvedIds,
			waitingIds,
			queuedIds,
			unmatchedResultIds,
			missingDeliveredIds,
			unresolvedIds,
			toolNames: [...counts.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([name, count]) => ({ name, count })),
			expectedCount: expectedIds.length,
			deliveredCount: deliveredIds.length,
			resolvedCount: resolvedIds.length,
			waitingCount: waitingIds.length,
			queuedCount: queuedIds.length,
			unmatchedResultCount: unmatchedResultIds.length,
		};
	}
}

interface TurnStore {
	ctx: QueryContext;
	contextStack: QueryContext[];
}

// Per-turn AsyncLocalStorage so concurrent top-level turns each get their own
// isolated QueryContext. Falls back to module-level singletons for code paths
// (tests, non-concurrent Pi use) that don't call runWithFreshTurnContext.
// Extension instances share a provider registry. Share its routing state as well,
// so a child's lifecycle callback and the original provider use the same store.
const runtimeKey = Symbol.for("claude-bridge:session-routing-v2");
const globals = globalThis as Record<symbol, any>;
const runtime: {
  storage: AsyncLocalStorage<TurnStore>;
  sessions: Map<string, TurnStore>;
  anonymous: WeakMap<object, TurnStore>;
} = globals[runtimeKey] ??= {
  storage: new AsyncLocalStorage<TurnStore>(),
  sessions: new Map(),
  anonymous: new WeakMap(),
};
const turnStorage = runtime.storage;

/** Pi passes sessionId on every provider call. Older direct callers can use
 * their turn's AbortSignal as identity; neither path guesses from active queries.
 * Always enter the selected store, even when a child inherits its parent's ALS. */
export function runWithSessionContext<T>(key: string | object | undefined, fn: () => T, freshWhenIdle = false): T {
  if (!key) return runWithFreshTurnContext(fn);
  let store = typeof key === "string" ? runtime.sessions.get(key) : runtime.anonymous.get(key);
  if (!store || (freshWhenIdle && !store.ctx.activeQuery)) {
    const next = new QueryContext();
    if (store) {
      next.session = store.ctx.session ? { ...store.ctx.session } : null;
      next.extensionApi = store.ctx.extensionApi;
      next.piUI = store.ctx.piUI;
    }
    // Old teardown callbacks retain their own store and cannot clear or classify
    // a new query started immediately after Pi receives the final answer.
    store = { ctx: next, contextStack: [] };
    if (typeof key === "string") runtime.sessions.set(key, store);
    else runtime.anonymous.set(key, store);
  }
  return turnStorage.run(store, fn);
}

export function forgetSessionContext(key: string): void {
  runtime.sessions.delete(key);
}
let _fallbackCtx = new QueryContext();
const _fallbackStack: QueryContext[] = [];

export function ctx(): QueryContext {
	return turnStorage.getStore()?.ctx ?? _fallbackCtx;
}

export function stackDepth(): number {
	return (turnStorage.getStore()?.contextStack ?? _fallbackStack).length;
}

export function pushContext(): void {
	const store = turnStorage.getStore();
	if (store) {
		if (!store.ctx.activeQuery) throw new Error("pushContext() called with no active query");
		store.contextStack.push(store.ctx);
		store.ctx = new QueryContext();
	} else {
		if (!_fallbackCtx.activeQuery) throw new Error("pushContext() called with no active query");
		_fallbackStack.push(_fallbackCtx);
		_fallbackCtx = new QueryContext();
	}
}

export function popContext(): void {
	const store = turnStorage.getStore();
	if (store) {
		if (store.contextStack.length === 0) throw new Error("popContext() called with empty stack");
		const parent = store.contextStack[store.contextStack.length - 1];
		parent.deferredUserMessages.push(...store.ctx.deferredUserMessages);
		store.ctx = store.contextStack.pop()!;
	} else {
		if (_fallbackStack.length === 0) throw new Error("popContext() called with empty stack");
		const parent = _fallbackStack[_fallbackStack.length - 1];
		parent.deferredUserMessages.push(..._fallbackCtx.deferredUserMessages);
		_fallbackCtx = _fallbackStack.pop()!;
	}
}

// Runs fn inside a fresh per-turn AsyncLocalStorage slot so concurrent top-level
// turns don't share QueryContext state. Call this at every fresh streamSimple
// entry point (i.e., non-reentrant calls to streamClaudeAgentSdk).
export function runWithFreshTurnContext<T>(fn: () => T): T {
	return turnStorage.run({ ctx: new QueryContext(), contextStack: [] }, fn);
}

// Returns true when the current call chain is already inside a runWithFreshTurnContext
// slot. Use to guard against double-wrapping.
export function isInTurnContext(): boolean {
	return turnStorage.getStore() !== undefined;
}

// Test-only: drop fallback state so test files can start from a clean module.
export function resetStack(): void {
	_fallbackCtx = new QueryContext();
	_fallbackStack.length = 0;
	runtime.sessions.clear();
	runtime.anonymous = new WeakMap();
}
