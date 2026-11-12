// Canonical selection + display order for the model picker.
// `resolveModelId` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

export const FABLE_MODEL_ID = "claude-fable-5";
export const FABLE_FALLBACK_MODEL_ID = "claude-opus-4-8";

export const FABLE_5_1_MODEL_ID = "claude-fable-5-1";
export const FABLE_5_2_MODEL_ID = "claude-fable-5-2";

const FABLE_MODEL_IDS = new Set([FABLE_5_2_MODEL_ID, FABLE_5_1_MODEL_ID, FABLE_MODEL_ID]);

export function fallbackModelForPrimaryModel(modelId: string): string | undefined {
	return FABLE_MODEL_IDS.has(modelId) ? FABLE_FALLBACK_MODEL_ID : undefined;
}

export const MODEL_IDS_IN_ORDER = [
	FABLE_5_2_MODEL_ID,
	FABLE_5_1_MODEL_ID,
	FABLE_MODEL_ID,
	"claude-opus-5-5",
	"claude-opus-5",
	FABLE_FALLBACK_MODEL_ID,
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-5-5",
	"claude-sonnet-5",
	"claude-sonnet-4-6",
	"claude-haiku-5-5",
	"claude-haiku-4-5",
];

type BridgeModelMetadata = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
};

const FALLBACK_MODELS: Record<string, BridgeModelMetadata> = {
	[FABLE_5_2_MODEL_ID]: {
		id: FABLE_5_2_MODEL_ID,
		name: "Claude Fable 5.2",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[FABLE_5_1_MODEL_ID]: {
		id: FABLE_5_1_MODEL_ID,
		name: "Claude Fable 5.1",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[FABLE_MODEL_ID]: {
		id: FABLE_MODEL_ID,
		name: "Claude Fable 5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	"claude-opus-5-5": {
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	"claude-opus-5": {
		id: "claude-opus-5",
		name: "Claude Opus 5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	"claude-sonnet-5-5": {
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	"claude-sonnet-5": {
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	"claude-haiku-5-5": {
		id: "claude-haiku-5-5",
		name: "Claude Haiku 5.5",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
	[FABLE_FALLBACK_MODEL_ID]: {
		id: FABLE_FALLBACK_MODEL_ID,
		name: "Claude Opus 4.8",
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh" },
		input: ["text", "image"],
		contextWindow: 1000000,
		maxTokens: 128000,
	},
};

/** Short display name for notices, e.g. "Fable 5.2"; unknown ids pass through. */
export function modelDisplayName(modelId: string): string {
	return FALLBACK_MODELS[modelId]?.name.replace(/^Claude /, "") ?? modelId;
}

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// keep MODEL_IDS_IN_ORDER ordering, and fill bridge-owned future IDs when pi-ai
// has not shipped metadata for them yet. Unknown missing IDs are still dropped.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id) ?? FALLBACK_MODELS[id])
		.filter((m) => m != null)
		// Forward thinkingLevelMap so per-model overrides (e.g. opus-4-7 mapping
		// xhigh→xhigh instead of xhigh→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

export function resolveModelId(models: Array<{ id: string }>, input: string): string {
	const lower = input.toLowerCase();
	// Exact IDs win before substring shortcuts: "claude-opus-5" is a substring of
	// "claude-opus-5-5", which is listed first.
	const match = models.find((m) => m.id === lower) ?? models.find((m) => m.id.includes(lower));
	return match ? match.id : input;
}
