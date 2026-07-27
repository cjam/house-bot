import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import telegramifyMarkdown from "telegramify-markdown";
import type { LanguageModel, ToolSet } from "ai";
import { loadConfig, type Config } from "./config";
import { createSessionStore, type SessionStore } from "./sessions";
import { ask as realAsk, type AskParams, type AskResult } from "./agent";
import { createMcpTools } from "./mcp";
import { resolveProvider } from "./provider";

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

export type BotDeps = {
  config: Config;
  sessionStore: SessionStore;
  ask: (params: AskParams) => Promise<AskResult>;
  systemPrompt: string;
  /** The resolved model every turn runs on. */
  model: LanguageModel;
  /** MCP tools (plus any provider web-search tool), merged into one set. */
  tools: ToolSet;
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

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("typing");

    let result: AskResult;
    try {
      result = await deps.ask({
        messages: deps.sessionStore.get(chatId) ?? [],
        prompt: ctx.message.text,
        systemPrompt: buildSystemPrompt(deps.systemPrompt),
        model: deps.model,
        tools: deps.tools,
        maxSteps: deps.config.maxSteps,
      });
    } catch (err) {
      console.error(
        `Agent turn failed for chat ${chatId}:`,
        err instanceof Error ? err.message : err,
      );
      await ctx.reply(errorReplyFor(err));
      return;
    }

    await deps.sessionStore.set(chatId, result.messages);

    // The model replies in GitHub-flavored Markdown, which Telegram won't render
    // raw. Convert each chunk to Telegram's MarkdownV2 (with escaping) and send
    // it formatted; if Telegram still rejects the entities (e.g. a chunk boundary
    // split a span), fall back to the plain text so the reply always gets through.
    for (const chunk of chunkText(result.text, REPLY_CHUNK_SIZE)) {
      try {
        await ctx.reply(telegramifyMarkdown(chunk, "escape"), { parse_mode: "MarkdownV2" });
      } catch (err) {
        console.error(
          `MarkdownV2 reply rejected for chat ${chatId}, sending plain:`,
          err instanceof Error ? err.message : err,
        );
        await ctx.reply(chunk);
      }
    }
  });

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

  const bot = createBot({
    config,
    sessionStore,
    ask: realAsk,
    systemPrompt: config.systemPrompt,
    model,
    tools,
  });

  const runner = run(bot);
  console.log("House bot running (long polling).");

  const stop = () => {
    console.log("Shutting down...");
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
