# house-bot

A Telegram bot that fronts a Claude agent (via the Claude Agent SDK) with access to homelab MCP
servers — Mealie recipes today, more later. Each Telegram chat gets its own resumable agent
session; only tools that start with `mcp__`, plus `WebSearch`, are ever allowed to run — no shell,
no filesystem access.

## Stack

Bun + TypeScript (ESM), [grammY](https://grammy.dev) with the
[`@grammyjs/runner`](https://grammy.dev/plugins/runner) plugin for long polling, and
[`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).
The Agent SDK bundles its own native CLI binary, so there's no separate Claude Code install and no
Node runtime required.

## Setup

### 1. Create a Telegram bot

Message [@BotFather](https://t.me/BotFather) on Telegram, run `/newbot`, and follow the prompts.
You'll get a token that looks like `123456789:AAабвгдежзиклмнопрстуфхцчшщ`. That's `TELEGRAM_TOKEN`.

### 2. Find your chat ID(s)

Message your new bot, then visit
`https://api.telegram.org/bot<TELEGRAM_TOKEN>/getUpdates` in a browser (with your real token) and
look for `"chat":{"id": ...}`. For a group chat, add the bot to the group first. Put the numeric
ID(s), comma-separated, in `ALLOWED_CHAT_IDS`. Any chat not in this list is silently ignored.

### 3. Get a Mealie API token

In Mealie, go to your user profile → API Tokens → create a new token. Set `MEALIE_URL` to your
Mealie instance's MCP endpoint (e.g. `http://mealie.local:9000/api/mcp`) and `MEALIE_TOKEN` to the
token. The bot connects to Mealie in-process, so a LAN-only URL is fine — no need to expose it to
the internet.

### 4. Anthropic API key

Set `ANTHROPIC_API_KEY`. The Agent SDK reads this itself; the bot only asserts it's present at
startup.

Copy `.env.example` to `.env` and fill in the values above.

## Local run

```bash
bun install
bun test          # unit tests
bun run typecheck
bun start         # or `bun run dev` for --watch
```

On boot the bot probes every configured MCP server and logs the resolved `mcp__*` tool list (or a
clear error). If an HTTP-transport MCP server fails to connect, the log includes a hint to try
`type: "sse"` instead — useful if you're not sure which transport your server speaks.

## Docker

```bash
cp .env.example .env   # fill in values first
docker compose up -d --build
```

Two volumes persist state across restarts:

- `claude-sessions` → `/root/.claude` — the Agent SDK's own session transcripts.
- `bot-data` → `/app/data` — the chat-id → session-id map (`data/sessions.json`).

**Run only one instance.** Telegram's long-polling `getUpdates` call fails with HTTP 409 if two
processes poll with the same bot token at once.

The container runs as `root` so `$HOME` (`/root`) is deterministic for the session volume. If you
harden the image to run as a non-root `bun` user, repoint the `claude-sessions` volume to
`/home/bun/.claude` instead.

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

If you'd rather build locally on an ARM host, build the image *on* the target architecture — the
Agent SDK's native binary is a platform-specific `optionalDependency`, and `bun install` needs to
run on `linux-arm64` for that variant to resolve. (The CI workflow handles this by building the
arm64 image under QEMU emulation.)

## Usage

- `/start` — health check; confirms the bot is online.
- `/reset` — clears the current chat's saved session, so the next message starts a fresh
  conversation with the agent.
- Any other text message is sent to the agent as a new turn (or a continuation of the chat's
  existing session), with a "typing…" indicator while it works. Long replies are split into
  chunks under Telegram's 4096-character message cap.

## Adding more MCP servers

MCP servers are built from environment variables in `src/config.ts`, in `buildMcpServers()`. To
add one (e.g. Homebox), add its env vars to `.env.example` and extend the function:

```ts
if (env.HOMEBOX_URL) {
  servers.homebox = {
    type: "http",
    url: env.HOMEBOX_URL,
    headers: env.HOMEBOX_TOKEN ? { Authorization: `Bearer ${env.HOMEBOX_TOKEN}` } : {},
  };
}
```

If a server doesn't speak Streamable HTTP, use `type: "sse"` instead — same shape otherwise. The
startup probe will tell you which transport failed and suggest the swap.

## Persistence & security notes

- Each Telegram chat maps to one resumable Agent SDK session (`chat_id -> session_id`), persisted
  to `data/sessions.json` with an atomic write (write to `.tmp`, then rename) so a crash mid-write
  never corrupts the file.
- The allowlist middleware silently drops updates from any chat not in `ALLOWED_CHAT_IDS` — no
  reply, no log noise from randos finding the bot.
- The `canUseTool` permission gate only allows tool names starting with `mcp__`, plus `WebSearch`.
  Everything else — shell, filesystem, arbitrary tools — is denied. This is the only line of
  defense between "Telegram message" and "agent runs a command on your homelab," so don't loosen
  it without thinking hard about what's on the other end of that MCP server.
- `.env` is gitignored; only `.env.example` (with empty values) is committed. This repo is public
  — never commit real tokens.
