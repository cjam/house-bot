import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import type { LanguageModel, ToolSet } from "ai";
import { loadConfig, type Config } from "./config";
import { createSessionStore, type SessionStore } from "./sessions";
import { ask as realAsk, type AskParams, type AskResult } from "./agent";
import { createMcpTools } from "./mcp";
import { resolveProvider } from "./provider";

const SYSTEM_PROMPT =
  "You are a concise, practical household assistant. Help with meal planning, recipes, " +
  "inventory, and other home-management tasks using the tools available to you. Keep " +
  "replies short and actionable. Don't guess at information a tool could answer.";

const REPLY_CHUNK_SIZE = 4000;

/**
 * Append today's date to the system prompt. The Claude Agent SDK used to supply
 * this automatically; the plain AI SDK does not, so without it the model can't
 * reason about relative dates ("this week", "today's meals"). Uses the process
 * timezone — set the TZ env var to control it.
 */
export function systemPromptWithDate(base: string, now: Date = new Date()): string {
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
        systemPrompt: systemPromptWithDate(deps.systemPrompt),
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

    for (const chunk of chunkText(result.text, REPLY_CHUNK_SIZE)) {
      await ctx.reply(chunk);
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
    systemPrompt: SYSTEM_PROMPT,
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
