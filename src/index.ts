import { Bot } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { loadConfig, type Config } from "./config";
import { createSessionStore, type SessionStore } from "./sessions";
import { ask as realAsk, probeMcpServers, describeMcpProbe, type AskParams, type AskResult } from "./agent";
import { canUseTool, ALLOWED_BUILTIN_TOOLS } from "./tools";

const SYSTEM_PROMPT =
  "You are a concise, practical household assistant. Help with meal planning, recipes, " +
  "inventory, and other home-management tasks using the tools available to you. Keep " +
  "replies short and actionable. Don't guess at information a tool could answer.";

const REPLY_CHUNK_SIZE = 4000;

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
        prompt: ctx.message.text,
        resume: deps.sessionStore.get(chatId),
        systemPrompt: deps.systemPrompt,
        model: deps.config.model,
        mcpServers: deps.config.mcpServers,
        canUseTool,
        builtinTools: [...ALLOWED_BUILTIN_TOOLS],
      });
    } catch (err) {
      console.error(
        `Agent turn failed for chat ${chatId}:`,
        err instanceof Error ? err.message : err,
      );
      await ctx.reply(errorReplyFor(err));
      return;
    }

    await deps.sessionStore.set(chatId, result.sessionId);

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

  const sessionStore = createSessionStore(config.sessionFile);
  await sessionStore.load();

  console.log("Probing MCP servers...");
  try {
    const probe = await probeMcpServers(config.mcpServers, config.model);
    for (const line of describeMcpProbe(probe, config.mcpServers)) {
      console.log(line);
    }
  } catch (err) {
    console.error("MCP probe failed:", err);
  }

  const bot = createBot({
    config,
    sessionStore,
    ask: realAsk,
    systemPrompt: SYSTEM_PROMPT,
  });

  const runner = run(bot);
  console.log("House bot running (long polling).");

  const stop = () => {
    console.log("Shutting down...");
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
