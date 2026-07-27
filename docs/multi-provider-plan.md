# Multi-provider / OpenRouter support — plan & handoff

Status: **Option B implemented** (2026-07-25). The bot now runs on the Vercel AI SDK
(`ai`) routed through OpenRouter by default, with a `resolveModel()` seam in
[`src/provider.ts`](../src/provider.ts) for direct providers. Sessions persist a
message array, MCP connects via [`@ai-sdk/mcp`](../src/mcp.ts), and `WebSearch` is
replaced by OpenRouter's optional web-search tool (`WEB_SEARCH=true`). The notes
below are kept as the original design rationale.

Written 2026-07-25.

Goal: let this bot route AI requests through a non-Anthropic provider (initially
OpenRouter, which the user has credits for), ideally in a provider-agnostic way.

## Background: how the bot works today

The whole bot is built on the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`).
The single `query()` call in [`src/agent.ts`](../src/agent.ts) (`ask()`) provides, for free:

- the agentic multi-step **tool loop**
- **session resume** (the bot persists a `sessionId` per chat — see [`src/sessions.ts`](../src/sessions.ts))
- **tool gating** via the `canUseTool` hook (allowlist in [`src/tools.ts`](../src/tools.ts))
- **built-in tools** (e.g. `WebSearch`) — these are Claude Code features
- **MCP server** wiring — HTTP/SSE servers configured via the `MCP_SERVERS` JSON env var
  ([`src/config.ts`](../src/config.ts) `buildMcpServers`), connected through an in-process
  name-shortening proxy ([`src/mcp-proxy.ts`](../src/mcp-proxy.ts))

`model` is already a config value ([`src/config.ts`](../src/config.ts), default `claude-sonnet-5`).
Config currently hard-requires `ANTHROPIC_API_KEY` at startup.

The core constraint: **the Claude Agent SDK speaks Anthropic's Messages API; OpenRouter
speaks OpenAI's `/v1/chat/completions`.** So "support OpenRouter" is fundamentally a
question of how far to move away from the SDK.

Important caveat regardless of approach: the Claude Agent SDK is Claude Code as a library —
its prompts and tool-use loop are **tuned for Claude models**. Non-Claude models will run
but agentic/tool-calling quality may degrade. Cleanest use of OpenRouter credits = route
**Claude models** through it; running other models is the real risk, not the plumbing.

## The two viable approaches

### Option A — Anthropic-compatible gateway in front of OpenRouter (least code)

Keep the Claude Agent SDK entirely. Run a translating proxy (e.g. **LiteLLM**) that exposes
an Anthropic `/v1/messages` endpoint and forwards to OpenRouter. The SDK already honors
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`, so you repoint it and change almost no code.

- Proxy config maps a model name (e.g. `openrouter/anthropic/claude-sonnet-4.5`) to the OpenRouter key.
- Bot env: `ANTHROPIC_BASE_URL=http://litellm:4000`, `ANTHROPIC_AUTH_TOKEN=<proxy key>`,
  `MODEL=<proxy model name>`.
- Relax the `ANTHROPIC_API_KEY` assertion in [`src/config.ts`](../src/config.ts) to accept
  "direct key OR base URL + auth token."
- Add a LiteLLM service to `docker-compose.dev.yml` + a LiteLLM config file.

Keeps MCP, sessions, tool gating, chunked replies — all of [`src/index.ts`](../src/index.ts) untouched.
Roughly an afternoon. **Verify LiteLLM's `/v1/messages` passthrough + tool-call translation
against current LiteLLM docs before committing** — that's the load-bearing assumption.

Trade-off: still married to the Claude harness. Good if the real goal is "spend OpenRouter
credits on Claude models."

### Option B — Provider-agnostic agent framework (recommended if the goal is true provider independence)

Replace the SDK-based `ask()` with a provider-agnostic agent library. Best fit for this
TS/Bun codebase is the **Vercel AI SDK** (`ai`):

- Provider-agnostic via provider packages: `@ai-sdk/openai`, `@ai-sdk/anthropic`, and a
  first-class `@openrouter/ai-sdk-provider`. Provider becomes a one-line config choice.
- Agentic loop: `generateText`/`streamText` with `tools` + `stopWhen: stepCountIs(n)`.
- MCP: `experimental_createMCPClient` connects over SSE / Streamable HTTP (matches the
  existing `MCP_SERVERS` http/sse configs), returns tools you spread into `tools`. The
  [`src/mcp-proxy.ts`](../src/mcp-proxy.ts) name-shortening logic largely carries over.

**What must be rebuilt** (these currently come *from* the Claude Agent SDK):

- **Sessions** — AI SDK is stateless. Persist the **message array** per chat instead of a
  `sessionId`; [`src/sessions.ts`](../src/sessions.ts) changes from "sessionId + idle timer"
  to "message history + idle timer."
- **Tool gating** — no `canUseTool`. Gate inside each tool's `execute`, or filter the tool
  set before the call; [`src/tools.ts`](../src/tools.ts) allowlist becomes a filter step.
- **Built-in tools** — `WebSearch` etc. are Claude Code features; wire equivalents yourself
  or use a provider tool.

Alternatives considered (all TS, all provider-agnostic + MCP):
- **Mastra** — heavier framework built on top of the Vercel AI SDK; gives sessions/memory/
  workflows as batteries instead of rebuilding them, at the cost of adopting its runtime.
- **OpenAI Agents SDK (`@openai/agents`)** — agentic loop + handoffs + MCP; works with
  OpenRouter (OpenAI-compatible); more opinionated than the AI SDK.
- **LangChain.js / LangGraph.js** — most abstraction; usually more than this bot needs.

## Recommendation

- If the goal is **"use OpenRouter credits but keep Claude models"** → **Option A** (gateway).
  Minimal change, everything behaves as today.
- If the goal is **genuine provider independence** (run GPT/Llama/etc., swap freely) →
  **Option B** with the **Vercel AI SDK + `@openrouter/ai-sdk-provider`**. More work now
  (rebuild sessions as message-history, move tool gating to a filter), but unties the bot
  from Claude Code.

Open decision for whoever picks this up: **which models does the user actually want to run?**
That answer selects the approach.

## Suggested next step

Prototype the Option B version of `ask()` — a provider-agnostic `agent.ts` using the Vercel
AI SDK wired to OpenRouter, reusing the existing `MCP_SERVERS` configs — and compare it
side-by-side with the current SDK-based `ask()` before committing to a rewrite.

## Key files

- [`src/agent.ts`](../src/agent.ts) — `ask()`, the single integration point with the Claude Agent SDK
- [`src/index.ts`](../src/index.ts) — bot wiring; calls `ask()` per message, passes model/mcp/tools
- [`src/config.ts`](../src/config.ts) — env parsing; `ANTHROPIC_API_KEY` assertion + `MODEL` default live here
- [`src/sessions.ts`](../src/sessions.ts) — per-chat session store (sessionId + idle timeout)
- [`src/mcp-proxy.ts`](../src/mcp-proxy.ts) — in-process MCP proxy that shortens tool names
- [`src/tools.ts`](../src/tools.ts) — `canUseTool` gate + allowed built-in tools list
- `.env.example` — documents `MODEL`, `MCP_SERVERS`, `ANTHROPIC_API_KEY`, etc.
