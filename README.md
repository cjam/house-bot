# house-bot

A Telegram bot that fronts an LLM agent with access to homelab MCP servers — Mealie recipes today,
more later. Provider-agnostic: it routes through [OpenRouter](https://openrouter.ai) by default
(one key reaching Claude, GPT, Gemini, and open models), so switching models is a one-line config
change. Each Telegram chat gets its own conversation that persists across messages; the only tools
the agent can run are the MCP tools you configure (plus an optional web search) — no shell, no
filesystem access.

## Stack

Bun + TypeScript (ESM), [grammY](https://grammy.dev) with the
[`@grammyjs/runner`](https://grammy.dev/plugins/runner) plugin for long polling, and the
provider-agnostic [Vercel AI SDK](https://ai-sdk.dev) (`ai`) for the agentic tool loop. The model
provider is a swappable package: [`@openrouter/ai-sdk-provider`](https://www.npmjs.com/package/@openrouter/ai-sdk-provider)
by default, with a `resolveModel()` seam in [`src/provider.ts`](src/provider.ts) for dropping in
direct `@ai-sdk/*` providers. MCP servers connect through [`@ai-sdk/mcp`](https://www.npmjs.com/package/@ai-sdk/mcp).

## Setup

### 1. Create a Telegram bot

Message [@BotFather](https://t.me/BotFather) on Telegram, run `/newbot`, and follow the prompts.
You'll get a token that looks like `123456789:AAабвгдежзиклмнопрстуфхцчшщ`. That's `TELEGRAM_TOKEN`.

### 2. Find your chat ID(s)

Message your new bot, then visit
`https://api.telegram.org/bot<TELEGRAM_TOKEN>/getUpdates` in a browser (with your real token) and
look for `"chat":{"id": ...}`. For a group chat, add the bot to the group first. Put the numeric
ID(s), comma-separated, in `ALLOWED_CHAT_IDS`. Any chat not in this list is silently ignored.

### 3. Configure MCP servers

All MCP servers are configured through a single `MCP_SERVERS` environment variable — a JSON object
keyed by server name, where each value is an MCP server config. Add as many as you like; no code
changes or per-server env vars needed.

```json
{
  "mealie": {
    "type": "http",
    "url": "http://mealie.local:9000/api/mcp",
    "headers": { "Authorization": "Bearer YOUR_MEALIE_TOKEN" }
  }
}
```

In `.env` this must be on a single line:

```
MCP_SERVERS={"mealie":{"type":"http","url":"http://mealie.local:9000/api/mcp","headers":{"Authorization":"Bearer YOUR_MEALIE_TOKEN"}}}
```

Each value is an MCP server config: `type` is `"http"` or `"sse"`, plus a `url` and optional
`headers` (a local `stdio` process is also supported). Put the full `Authorization` header (token
included) directly in the JSON. For Mealie, create the token under your Mealie user profile → API
Tokens. LAN-only URLs are fine — no need to expose anything to the internet.

### 4. Provider API key and model

`PROVIDER` picks the active provider (default `openrouter`), and each provider reads its own
namespaced vars — `<PROVIDER>_API_KEY` and `<PROVIDER>_MODEL` — so their settings never collide and
each can grow independent extras. Only the active provider's block is read; the rest can stay blank.

For the default OpenRouter provider, set `OPENROUTER_API_KEY` and optionally `OPENROUTER_MODEL` (a
slug, default `google/gemini-2.5-flash` — a cost-efficient pick with reliable tool calling; swap
freely, e.g. `anthropic/claude-sonnet-4.5` for harder tasks). To use a direct provider instead, set
`PROVIDER` and its own `*_API_KEY`/`*_MODEL` (and enable its branch in
[`src/provider.ts`](src/provider.ts)) — direct models use the provider's native id, not a slug.

Note: the agentic tool loop runs on the model you choose — non-Claude models work, but tool-calling
quality varies by model.

Copy `.env.example` to `.env` and fill in the values above.

## Local run

```bash
bun install
bun test          # unit tests
bun run typecheck
bun start         # or `bun run dev` for --watch
```

### Dev container

`.devcontainer/` defines a ready-to-go environment (Bun, git, the GitHub CLI, and a nested Docker
daemon via docker-in-docker). Open the repo in VS Code and "Reopen in Container", or use the
devcontainer CLI — `bun install` runs automatically on create. `bun test` and `bun run typecheck`
need no secrets; to run the bot, copy `.env.example` to `.env` (Bun auto-loads it) and fill in the
values.

house-bot itself runs locally with Bun, not in Docker — only mealie-mcp (the Mealie MCP bridge)
runs in a container:

```bash
bun run dev:up   # starts mealie-mcp in the background (docker-compose.dev.yml)
bun run dev      # runs house-bot locally with --watch
```

Because the devcontainer's Docker daemon shares this shell's network namespace, `MCP_SERVERS` can
just point at `http://localhost:8000/mcp` for mealie-mcp — no compose-network hostname needed.

On boot the bot connects to every configured MCP server and logs the resolved tool list (or a clear
error if a server is unreachable — the bot still starts, just without that server's tools).

Each server's tools are namespaced per server (`<server>_<tool>`) and merged into one tool set.
Names that would exceed the providers' 64-character function-name limit — common for servers that
auto-name tools from long route/operation IDs, like Mealie — are truncated and suffixed with a
short deterministic hash (unique across servers); the startup log notes how many were shortened.
Without this, a single over-long name makes the API reject the whole request, so the model ends up
with *no* MCP tools.

## Docker

```bash
cp .env.example .env   # fill in values first
docker compose up -d --build
```

One volume persists state across restarts:

- `bot-data` → `/app/data` — the chat-id → conversation-history map (`data/sessions.json`).

**Run only one instance.** Telegram's long-polling `getUpdates` call fails with HTTP 409 if two
processes poll with the same bot token at once.

### Prebuilt image (GitHub Container Registry)

Every push to `main` (and every `v*` tag) is built by the
[`docker-publish`](.github/workflows/docker-publish.yml) GitHub Actions workflow and published to
`ghcr.io/cjam/house-bot` for both `linux/amd64` and `linux/arm64` — so you can pull it straight
onto an x86 server or an ARM Raspberry Pi without building locally:

```bash
docker pull ghcr.io/cjam/house-bot:latest
```

Tags: `latest` (default branch), the branch name, `sha-<commit>`, and semver tags (`1.2.3`,
`1.2`) when you push a `v*` git tag. To run the prebuilt image with compose, swap `build: .` for
`image: ghcr.io/cjam/house-bot:latest` in `docker-compose.yml`.

The image is pure JS/TS with no platform-specific native binaries, so it builds cleanly for both
architectures. (The CI workflow builds the arm64 image under QEMU emulation.)

## Usage

- `/start` — health check; confirms the bot is online.
- `/reset` — clears the current chat's saved session, so the next message starts a fresh
  conversation with the agent.
- Any other text message is sent to the agent as a new turn (continuing the chat's existing
  conversation), with a "typing…" indicator while it works. Long replies are split into chunks
  under Telegram's 4096-character message cap.

## Adding more MCP servers

Add another key to the `MCP_SERVERS` JSON — no code changes needed. For example, to add Homebox
alongside Mealie:

```json
{
  "mealie": {
    "type": "http",
    "url": "http://mealie.local:9000/api/mcp",
    "headers": { "Authorization": "Bearer MEALIE_TOKEN" }
  },
  "homebox": {
    "type": "http",
    "url": "http://homebox.local/mcp",
    "headers": { "Authorization": "Bearer HOMEBOX_TOKEN" }
  }
}
```

If a server doesn't speak Streamable HTTP, use `"type": "sse"` instead — same shape otherwise. The
startup log will tell you if a server failed to connect.

## Persistence & security notes

- Each Telegram chat maps to one conversation history (`chat_id -> messages`), persisted to
  `data/sessions.json` with an atomic write (write to `.tmp`, then rename) so a crash mid-write
  never corrupts the file. A chat's history expires after `SESSION_IDLE_MINUTES` (default 15) of no
  messages — the next message after that starts a fresh conversation instead of resuming a stale
  one. (Migrating from the old Agent-SDK format is a one-time reset: those records are skipped on
  load, so existing chats simply start fresh.)
- The allowlist middleware silently drops updates from any chat not in `ALLOWED_CHAT_IDS` — no
  reply, no log noise from randos finding the bot.
- The agent can only call the tools it's handed: your configured MCP tools, plus the optional web
  search when `WEB_SEARCH=true`. There is no shell/filesystem tool in the set at all — the tool set
  *is* the allowlist. Still, that MCP server can do whatever its API allows, so think hard about
  what's on the other end before pointing the bot at it.
- `.env` is gitignored; only `.env.example` (with empty values) is committed. This repo is public
  — never commit real tokens.
