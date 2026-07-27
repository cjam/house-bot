import { Bot, InlineKeyboard, type Api } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import telegramifyMarkdown from "telegramify-markdown";
import type { LanguageModel, ToolSet } from "ai";
import { loadConfig, type Config } from "./config";
import { createSessionStore, type SessionStore } from "./sessions";
import { ask as realAsk, type AskParams, type AskResult } from "./agent";
import { createMcpTools } from "./mcp";
import { resolveProvider } from "./provider";
import { createScheduleStore, type Schedule, type ScheduleStore } from "./schedules";
import { createScheduler, type Scheduler } from "./scheduler";
import { createScheduleTools } from "./schedule-tools";
import { renderScheduleList, buildScheduleKeyboard, parseCallback } from "./schedule-ui";

const REPLY_CHUNK_SIZE = 4000;

/**
 * Compose the full system prompt for a turn: the deployment's base prompt
 * (configurable via SYSTEM_PROMPT) plus always-on runtime context the model
 * can't do without. Today the always-on layer is just the date — the Claude
 * Agent SDK used to supply this automatically; the plain AI SDK does not, so
 * without it the model can't reason about relative dates ("this week",
 * "today's meals"). Uses the process timezone — set the TZ env var to control it.
 */
export function buildSystemPrompt(base: string, now: Date = new Date()): string {
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZoneName: "short",
  }).format(now);
  return `${base}\n\nToday's date is ${date}.`;
}

export function chunkText(text: string, size: number): string[] {
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

/** Maps an agent-turn failure to a short, user-facing reply. */
export function errorReplyFor(err: unknown): string {
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (text.includes("rate limit") || text.includes("429")) {
    return "I'm being rate limited right now — please wait a minute and try again.";
  }
  return "Sorry, something went wrong handling that. Please try again.";
}

/**
 * Deliver a reply to a chat, chunked to Telegram's size limit. The model replies
 * in GitHub-flavored Markdown, which Telegram won't render raw, so each chunk is
 * converted to MarkdownV2 (with escaping); if Telegram rejects the entities (e.g.
 * a chunk boundary split a span) we fall back to plain text so the reply always
 * lands. Shared by the interactive handler and scheduled runs (which have no
 * incoming update to reply to, hence `api.sendMessage` rather than `ctx.reply`).
 */
export async function sendReply(api: Api, chatId: number, text: string): Promise<void> {
  for (const chunk of chunkText(text, REPLY_CHUNK_SIZE)) {
    try {
      await api.sendMessage(chatId, telegramifyMarkdown(chunk, "escape"), {
        parse_mode: "MarkdownV2",
      });
    } catch (err) {
      console.error(
        `MarkdownV2 reply rejected for chat ${chatId}, sending plain:`,
        err instanceof Error ? err.message : err,
      );
      await api.sendMessage(chatId, chunk);
    }
  }
}

export type BotDeps = {
  config: Config;
  sessionStore: SessionStore;
  ask: (params: AskParams) => Promise<AskResult>;
  systemPrompt: string;
  /** The resolved model every turn runs on. */
  model: LanguageModel;
  /** MCP tools (plus any provider web-search tool), merged into one set. */
  tools: ToolSet;
  /**
   * Schedule persistence. When provided (with `makeScheduler`), the bot wires up
   * scheduled prompts: the `/schedules` command, the schedule-management agent
   * tools, and the timers. Omitted in tests that only exercise chat handling.
   */
  store?: ScheduleStore;
  /**
   * Factory that builds the scheduler from the bot's own fire callback, letting
   * `main` retain the instance for lifecycle (start/stop) while the fire logic
   * (which needs the bot's turn runner) stays inside `createBot`.
   */
  makeScheduler?: (onFire: (schedule: Schedule) => Promise<void>) => Scheduler;
  /** Default timezone stamped on schedules created without an explicit one. */
  defaultTimezone?: string;
};

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.config.telegramToken);

  bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !deps.config.allowedChatIds.has(chatId)) {
      return;
    }
    await next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply("House bot is online and ready.");
  });

  bot.command("reset", async (ctx) => {
    await deps.sessionStore.clear(ctx.chat.id);
    await ctx.reply("Session cleared. Starting fresh next message.");
  });

  // Scheduling is optional: only wired when a store + scheduler factory are
  // supplied. Declared here so `runTurn` can hand the per-chat schedule tools a
  // live scheduler reference; it's assigned synchronously below, before any turn
  // (interactive or scheduled) can run.
  let scheduler: Scheduler | undefined;

  /**
   * Run one agent turn for a chat and deliver the reply. `useSession` threads the
   * chat's live conversation (and persists the result); scheduled "fresh" runs
   * pass false to stay isolated. When scheduling is wired, the per-chat
   * schedule-management tools are merged in so the model can manage schedules.
   */
  async function runTurn(args: {
    chatId: number;
    prompt: string;
    useSession: boolean;
  }): Promise<void> {
    const priorMessages = args.useSession ? (deps.sessionStore.get(args.chatId) ?? []) : [];
    const scheduleTools =
      deps.store && scheduler
        ? createScheduleTools({
            store: deps.store,
            scheduler,
            chatId: args.chatId,
            defaultTimezone: deps.defaultTimezone,
          })
        : {};
    const result = await deps.ask({
      messages: priorMessages,
      prompt: args.prompt,
      systemPrompt: buildSystemPrompt(deps.systemPrompt),
      model: deps.model,
      tools: { ...deps.tools, ...scheduleTools },
      maxSteps: deps.config.maxSteps,
    });
    if (args.useSession) await deps.sessionStore.set(args.chatId, result.messages);
    await sendReply(bot.api, args.chatId, result.text);
  }

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("typing");
    try {
      await runTurn({ chatId, prompt: ctx.message.text, useSession: true });
    } catch (err) {
      console.error(
        `Agent turn failed for chat ${chatId}:`,
        err instanceof Error ? err.message : err,
      );
      await ctx.reply(errorReplyFor(err));
    }
  });

  if (deps.store && deps.makeScheduler) {
    const store = deps.store;

    scheduler = deps.makeScheduler(async (schedule) => {
      try {
        await runTurn({
          chatId: schedule.chatId,
          prompt: schedule.prompt,
          useSession: schedule.sessionMode === "continue",
        });
      } catch (err) {
        console.error(
          `Scheduled turn failed for chat ${schedule.chatId}:`,
          err instanceof Error ? err.message : err,
        );
        await bot.api.sendMessage(schedule.chatId, errorReplyFor(err)).catch(() => {});
      }
    });

    // Live control panel: the listing plus inline buttons to run/pause/delete.
    bot.command("schedules", async (ctx) => {
      const list = store.list(ctx.chat.id);
      await ctx.reply(
        renderScheduleList(list),
        list.length > 0 ? { reply_markup: buildScheduleKeyboard(list) } : undefined,
      );
    });

    bot.on("callback_query:data", async (ctx) => {
      const parsed = parseCallback(ctx.callbackQuery.data);
      if (!parsed) {
        await ctx.answerCallbackQuery();
        return;
      }
      const chatId = ctx.chat?.id;
      const schedule = store.get(parsed.id);
      if (chatId === undefined || !schedule || schedule.chatId !== chatId) {
        await ctx.answerCallbackQuery({ text: "That schedule no longer exists." });
        return;
      }

      let note: string;
      switch (parsed.action) {
        case "run":
          void scheduler!.runNow(parsed.id);
          note = "Running now…";
          break;
        case "pause":
          await store.update(parsed.id, { enabled: false });
          scheduler!.sync(parsed.id);
          note = "Paused.";
          break;
        case "resume":
          await store.update(parsed.id, { enabled: true });
          scheduler!.sync(parsed.id);
          note = "Resumed.";
          break;
        case "del":
          await store.remove(parsed.id);
          scheduler!.sync(parsed.id);
          note = "Deleted.";
          break;
      }
      await ctx.answerCallbackQuery({ text: note });

      // Redraw the panel in place. An empty keyboard clears the buttons when the
      // last schedule is gone. editMessageText throws if nothing changed or the
      // message is too old to edit — harmless, so ignore it.
      const list = store.list(chatId);
      await ctx
        .editMessageText(renderScheduleList(list), {
          reply_markup: list.length > 0 ? buildScheduleKeyboard(list) : new InlineKeyboard(),
        })
        .catch(() => {});
    });
  }

  // Concise last-resort handler so an unexpected error logs a one-line message
  // instead of dumping the entire grammY context object to the console.
  bot.catch((err) => {
    console.error(
      "Unhandled bot error:",
      err.error instanceof Error ? err.error.message : err.error,
    );
  });

  return bot;
}

async function main() {
  const config = loadConfig();

  const sessionStore = createSessionStore(config.sessionFile, config.sessionIdleMs);
  await sessionStore.load();

  const scheduleStore = createScheduleStore(config.scheduleFile);
  await scheduleStore.load();

  const { model, webSearchTool } = resolveProvider(config);

  console.log("Connecting MCP servers...");
  const mcp = await createMcpTools(config.mcpServers, (line) => console.log(line));
  for (const line of mcp.describe()) {
    console.log(line);
  }

  const tools: ToolSet = {
    ...mcp.tools,
    ...(webSearchTool ? { web_search: webSearchTool } : {}),
  };
  console.log(
    `Model: ${config.provider}/${config.model}; web search ${config.webSearch ? "on" : "off"}.`,
  );

  let scheduler: Scheduler | undefined;
  const bot = createBot({
    config,
    sessionStore,
    ask: realAsk,
    systemPrompt: config.systemPrompt,
    model,
    tools,
    store: scheduleStore,
    defaultTimezone: config.timezone,
    makeScheduler: (onFire) => {
      scheduler = createScheduler({ store: scheduleStore, onFire, log: (line) => console.log(line) });
      return scheduler;
    },
  });

  await scheduler?.start();
  console.log(`Scheduler: ${scheduleStore.list().length} schedule(s) loaded.`);

  // Surface the commands in Telegram's "/" menu. Best-effort — a transient API
  // hiccup here shouldn't stop the bot from starting.
  await bot.api
    .setMyCommands([
      { command: "schedules", description: "List & manage scheduled prompts" },
      { command: "reset", description: "Start a fresh conversation" },
    ])
    .catch((err) => console.error("setMyCommands failed:", err instanceof Error ? err.message : err));

  const runner = run(bot);
  console.log("House bot running (long polling).");

  const stop = () => {
    console.log("Shutting down...");
    scheduler?.stop();
    void mcp.close();
    void runner.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Fatal error during startup:", err);
    process.exit(1);
  });
}
