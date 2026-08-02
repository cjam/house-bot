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

All persistent state lives in one directory, `/app/data`, kept across restarts by the `bot-data`
named volume in `docker-compose.yml`:

- `data/sessions.json` — the chat-id → conversation-history map.
- `data/schedules.json` — scheduled prompts (see [Scheduled prompts](#scheduled-prompts)).
- `data/settings.json` — per-chat settings overrides (see [Per-chat settings](#per-chat-settings)).
- `data/deploy.json` — the last release version announced on deploy (see [Release notes on
  deploy](#release-notes-on-deploy)).
- `data/logs/<chatId>.jsonl` — optional transcript logs, when `TRANSCRIPT_DIR` is set
  (see [Transcript log](#transcript-log)).

**This mount is required for anything to survive a restart.** Without a volume on `/app/data`,
recreating the container starts every chat fresh and drops every schedule. The bundled compose
file already wires it up; if you run the image by hand instead, mount the volume yourself:

```bash
docker run -d --env-file .env -v bot-data:/app/data ghcr.io/cjam/house-bot:latest
```

(Swap `-v bot-data:/app/data` for a bind mount like `-v "$PWD/data:/app/data"` if you'd rather keep
the files on the host where you can read them directly.)

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
- `/plan` — plan the upcoming dinners and post an **interactive plan card** (see
  [Meal-plan cards](#meal-plan-cards)). You can also just ask (*"plan our dinners this week"*).
- `/schedules` — list this chat's scheduled prompts with inline buttons to **run now**,
  **pause/resume**, and **delete** each one.
- `/settings` — show this chat's settings; `/setlocation <place>`, `/setprompt <text>`,
  `/setdays <1-14>`, and `/resetsettings` change them (see [Per-chat settings](#per-chat-settings)).
- Any other text message is sent to the agent as a new turn (continuing the chat's existing
  conversation), with a "typing…" indicator while it works. Long replies are split into chunks
  under Telegram's 4096-character message cap.

## Scheduled prompts

The bot can run a prompt on a schedule — recurring or one-time — and deliver the reply to a chat,
e.g. a weekly "start planning next week's meals" nudge or a one-off "remind me to defrost the roast
tomorrow at 4pm". There are two ways to manage schedules, and they operate on the same list:

- **Just ask, in plain language.** The agent has tools to create, list, update, pause, and delete
  schedules for the current chat: *"every Sunday at 5pm, start planning next week's meal plan"* or
  *"remind me tomorrow at 4pm to defrost the roast"* → it fills in the cron expression or datetime
  and confirms. Times use your `TZ` (below) unless you name another. When you ask to change an
  existing schedule (its time, prompt, or mode), it edits that one in place rather than adding a
  duplicate — *"move the meal-plan schedule to 8am and have it continue our conversation."*
- **`/schedules` command.** A live panel listing this chat's schedules with inline buttons to run,
  pause/resume, or delete each — handy when you'd rather tap than type.

A schedule is either **recurring** (a cron expression, e.g. `0 17 * * 0`) or a **one-off** (a fixed
datetime like *"tomorrow at 3pm"*, which runs once and then deletes itself). Both store the prompt
and a session mode: **fresh** (default) runs in isolation so a scheduled turn never pollutes an
ongoing chat, while **continue** resumes the chat's current conversation.

Schedules persist to `SCHEDULE_FILE` (default `data/schedules.json`) with the same atomic write as
sessions. Timers run in-process (via [`croner`](https://github.com/hexagon/croner)); if the bot is
down when a schedule was due, the missed run fires once on the next startup — including a one-off
whose time passed while it was offline. Times are interpreted in `TZ` (defaults to UTC), so set it
to your local zone for "this week", meal-plan dates, and one-off reminders to line up.

## Per-chat settings

Each chat can override the deployment defaults for its own conversations. Overridable settings:

- **System prompt** — a custom persona/instructions for this chat (falls back to `SYSTEM_PROMPT`).
- **Location** — the household's coordinates, used by the weather tool. Set by name; it's geocoded,
  and the place's **timezone** is adopted at the same time.
- **Timezone** — for the injected date and new schedules (set on its own, or via location).
- **Model** — a model slug for this chat, overriding the default; and **max steps** for the loop.
- **Plan days** — how many days a meal plan covers by default (`PLAN_DAYS`, default 5).

Settings are **overrides layered over the defaults**, resolved per turn — an unset field just uses
the `.env` value. As with schedules, there are two ways to change them:

- **Just ask.** *"We're in Tofino this week — set our location"* or *"use claude-sonnet here"* →
  the agent's settings tools update this chat and confirm.
- **Slash commands.** `/settings` shows the current values (marking each custom vs. default);
  `/setlocation <place>`, `/setprompt <text>`, `/setdays <1-14>`, and `/resetsettings` change or
  revert them.

## Meal-plan cards

Instead of a wall of text, the planner can present the week as an **interactive card** — one row
per day showing the weather (emoji + high/low, with a ⚠️ on smoky days) and the chosen recipe, plus
inline buttons. Ask *"plan our dinners"* (or run `/plan`) and the agent picks recipes, attaches a
couple of alternates per day, and posts the card:

```
🍽️ Dinner plan

Mon, Aug 3   ☀️ 24°/13°   Sheet-Pan Chicken Fajitas
Tue, Aug 4   ⛅ 21°/12°   Thai Green Curry
Wed, Aug 5   🌧️ 18°/11°   📝 Pizza night

Tap 🔀 to swap a day or 🚫 to skip it, then ✅ Lock it in.
```

- **🔀 per day / Shuffle all** — cycle a day (or every day) through its alternate recipes. This is
  instant: the card edits in place, with no model call and nothing written to Mealie yet.
- **🚫 skip a day** — mark a day as a note instead of a recipe (eating out, leftovers, a busy
  night). The button sets a generic "Eating out"; for a specific note just tell the bot (*"Friday is
  pizza night"*) and it sets that day's note. A skipped day keeps its weather and offers ↩️ to
  restore the recipe.
- **✅ Lock it in** — commits the plan to Mealie: chosen recipes become meal-plan entries (creating
  any missing recipe via the recipe sub-agent), and skipped days become plain note entries. Then the
  buttons drop and the card is marked *saved*.

The number of days comes from the chat's **Plan days** setting (default `PLAN_DAYS`, 5). Drafts are
held in memory until locked in, so a card's buttons stop working after a restart — just ask again.

Overrides persist to `SETTINGS_FILE` (default `data/settings.json`), kept **separate** from the
session and schedule files on purpose: settings are cold (rarely written), so folding them into the
per-message session record would rewrite them on every message.

## Release notes on deploy

When a new build starts up, the bot posts a short "I've been updated" message to each allowed chat —
the release title, a few highlight bullets, and (collapsed by default) a details section using
Telegram's expandable blockquote. It fires **once per version bump**: the last-announced version is
stored in `data/deploy.json` (in the persisted volume), so an ordinary restart or crash-loop stays
quiet, and a fresh install announces only the latest release rather than the whole history.

Release notes are authored in [`src/releases.ts`](src/releases.ts) — newest first. To announce a
deploy, add an entry at the top with a new `version`, a `title`, a few short `highlights`, and
optional longer `details`:

```ts
export const RELEASES: Release[] = [
  {
    version: "0.3.0",
    title: "Family calendar",
    highlights: ["Meal planning now accounts for busy nights"],
    details: "Longer prose here shows in the collapsible section.",
  },
  // …older releases below
];
```

The `version` is just a unique, ordered id (semver here) — it only needs to differ from the previous
top entry. The message is sent as MarkdownV2 with a plain-text fallback if Telegram rejects the
formatting, and the whole step is best-effort: a hiccup here never blocks startup.

## Transcript log

Set `TRANSCRIPT_DIR` (e.g. `./data/logs`) to record an **append-only, per-chat transcript** for
analysis — one file per chat at `<dir>/<chatId>.jsonl`, one JSON object per turn:

```json
{ "ts": "…", "chatId": -100…, "trigger": "message", "fresh": false, "priorMessages": 8,
  "prompt": "…", "reply": "…", "tools": [{ "name": "get_forecast", "args": {…} }],
  "model": "…", "usage": {…}, "steps": 3, "ms": 2140 }
```

It's **opt-in** (unset = off) and distinct from the live `sessions.json`, which only holds each
chat's *current* session and is overwritten every turn. The log is the durable history: it captures
which tools the model actually calls, token usage and latency per turn, the prompt→reply pairs for
tuning the system prompt, and the `fresh` vs. resumed flag — handy for spotting when a chat is
unexpectedly losing its context. Logging failures are swallowed — they never fail a turn.

This log is also what powers **recall**: with `TRANSCRIPT_DIR` set, the model gets a `recall` tool
that keyword-searches the chat's past sessions, so it can look up a fact or decision from weeks ago
that has fallen out of the live context instead of claiming it has no record. Each session is its own
file, so old ones can be pruned or archived independently.

## Agents & tool scoping

The bot runs a **meal-planning agent** (the household assistant) scoped to ~16 Mealie tools — the
meal-plan, recipe-search, cleanup, and shopping-list ones — rather than all ~130 the server exposes.
A smaller, relevant tool surface makes the model's tool selection far more reliable. Recipe creation
is delegated to a **recipe sub-agent**: the planner calls `find_or_create_recipe`, which runs a
focused, *isolated* nested turn with only the recipe tools (search / create / import) and returns the
recipe's title and slug — so the planning thread stays clean and the sub-agent can't wander into meal
plans or shopping lists. Agent definitions (persona + scoped tools) live in
[`src/agents.ts`](src/agents.ts).

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
- Scheduled prompts persist to `data/schedules.json` (same atomic write), each tagged with the
  chat that owns it. The management tools and `/schedules` buttons only ever see and touch the
  current chat's schedules, so one allowed chat can't manage another's.
- Per-chat settings persist to `data/settings.json` (same atomic write), keyed by chat id, and are
  resolved as overrides over the `.env` defaults on every turn. The settings tools and `/set*`
  commands are bound to the current chat, so one chat can't read or change another's.
- With `TRANSCRIPT_DIR` set, full prompt→reply transcripts are written to `data/logs/<chatId>.jsonl`
  — household conversation content at rest. It's opt-in and stays on your own box; leave it unset if
  you'd rather not persist message text beyond the live session.
- The allowlist middleware silently drops updates from any chat not in `ALLOWED_CHAT_IDS` — no
  reply, no log noise from randos finding the bot.
- The agent can only call the tools it's handed: your configured MCP tools, the built-in weather,
  schedule, and settings tools, plus the optional web search when `WEB_SEARCH=true`. There is no
  shell/filesystem tool in the set at all — the tool set *is* the allowlist. Still, that MCP server can do whatever its API allows, so think hard about
  what's on the other end before pointing the bot at it.
- `.env` is gitignored; only `.env.example` (with empty values) is committed. This repo is public
  — never commit real tokens.
