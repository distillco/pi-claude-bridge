# pi-claude-bridge

Run Claude Code as a Pi provider. Adds `claude-bridge/*` models to `/model` and routes Pi turns through the Claude Agent SDK while keeping Pi's tools and TUI.

Fork of [`@vanillagreen/pi-claude-bridge`](https://www.npmjs.com/package/@vanillagreen/pi-claude-bridge) (originally by vanillagreencom). That package lives inside a private monorepo; this fork extracts it as a standalone public package so it can receive targeted patches without depending on monorepo tooling.

## Why fork

The upstream bridge uses module-level singletons (`_ctx` in `query-state.ts`, `sharedSession` in `index.ts`) for all LLM query state. That works fine when Pi runs one task at a time. When a host daemon runs multiple concurrent tasks in the same Node.js process — e.g. a Manta worker daemon handling two cards simultaneously — the singletons are shared across all in-flight `backend.runTurn()` calls. The second task's turn start clobbers the first task's active stream reference and session state, causing the first task to silently stall.

This fork fixes that by wrapping `_ctx` and `contextStack` in a Node.js `AsyncLocalStorage` so each top-level call to `streamClaudeAgentSdk` gets its own isolated query context. Subagent reentrancy (`pushContext`/`popContext`) continues to work as before, scoped within each turn's own storage slot.

## Install

```bash
pi install npm:@timsu/pi-claude-bridge
```

Restart Pi after installation.

## Highlights

- `claude-bridge/claude-fable-5-1`, Fable 5, Opus 5.5, Opus 5, Opus 4.8, Opus 4.7, Sonnet, and Haiku in `/model`.
- Pi tool calls run on Pi; Claude Code handles reasoning.
- Tool-use turns block until Pi-delivered tool results reach Claude Code, including persistent subagent panes.
- Session continuity across normal turns, `/compact`, tree navigation, and abort recovery.
- Thinking-level forwarding with summarized Opus thinking display.
- Optional Claude effort overrides (`xhigh` → `max` for Opus 4.8).
- MCP isolation and Claude cloud-MCP suppression to keep tokens lean.
- Opt-in forwarding of `APPEND_SYSTEM.md` and recognized Pi prompt hooks.
- **Concurrent-task isolation**: per-turn `AsyncLocalStorage` context so multiple concurrent tasks in one process don't corrupt each other's query state.

## Settings

Open `/extensions:settings`; settings appear under the **Claude Bridge** tab.

### General

| Setting | What it does |
| --- | --- |
| Enable Claude bridge provider | Register `claude-bridge/*` models. Reload required. |

### Base prompt

| Setting | What it does |
| --- | --- |
| Forward AGENTS.md + skills | Append AGENTS.md and Pi's skills block. |

### Pi prompt context

| Setting | What it does |
| --- | --- |
| Forward APPEND_SYSTEM.md | Forward project/global `APPEND_SYSTEM.md` content. |

### Pi prompt hooks

| Setting | What it does |
| --- | --- |
| Forward project agents hook | Forward `pi-agents-tmux` Project Agents/Subagents list. |
| Forward task panel hook | Forward `pi-task-panel` workflow reminders. |
| Forward caveman hook | Forward `pi-caveman` response-style directives. |

### Claude Code

| Setting | What it does |
| --- | --- |
| Strict MCP config | Block filesystem MCP auto-loads; Pi owns tools. |
| Allow extra usage helper | Let the bridge launch Claude Code's `/extra-usage` flow when extra usage is required. |
| Fast mode | Enable Claude Code fast mode for bridge requests when the selected model supports it. |
| Force Claude effort | Override Pi's thinking-level mapping for every claude-bridge request. `none` keeps Pi's selected level; `max` sends Claude Code `--effort max`. |
| Model effort overrides | JSON object mapping model IDs to Claude Code efforts, e.g. `{"claude-opus-4-8":"max"}`. |
| Claude executable path | Explicit `claude` binary path; empty auto-detects. |

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to write bridge logs to `~/.pi/agent/claude-bridge.log` and per-query Claude Code CLI logs under `~/.pi/agent/cc-cli-logs/`.

## Upstream

Original package: [`@vanillagreen/pi-claude-bridge`](https://www.npmjs.com/package/@vanillagreen/pi-claude-bridge)


### Session routing and tool delivery in 1.5.6

The provider uses Pi's `options.sessionId` for query routing and Claude session persistence. Nested Agent sessions have their own active query, tool handlers, UI/API callbacks, and Claude session pointer even when they share a working directory and provider registry. Direct callers without a session ID can use a stable turn AbortSignal. The bridge does not infer identity from the sole active query or the working directory.

Completed Pi outputs are no longer mutated when the SDK sends additional tool blocks. The bridge queues undelivered calls for the next Pi stream, deduplicates completed tool IDs across SDK echoes, and drops the pending queue on cancellation. MCP registration alone no longer counts as delivery to Pi.

These fixes address Manta task `c-6560f827b518`: its child prompt was routed into the parent query at 2026-09-09 00:25:10 UTC; after a watchdog retry, MCP tool `toolu_01Cu8C2jCPaohYJESpgN4kv9` waited for thirty minutes although Pi never received that call. Tests use a mocked Claude SDK with real Pi streams and a real Pi agent loop, covering nested sessions, late parallel calls, duplicate echoes, cancellation, immediate subsequent prompts, and child lifecycle events. No model credentials are required for those tests.
