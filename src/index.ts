import { resolve } from "node:path";
import { Bot, InlineKeyboard, type Api } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import telegramifyMarkdown from "telegramify-markdown";
import type { LanguageModel, ToolSet } from "ai";
import { loadConfig, type Config } from "./config";
import { createSessionStore, newSessionId, type SessionStore } from "./sessions";
import { ask as realAsk, type AskParams, type AskResult } from "./agent";
import { createMcpTools } from "./mcp";
import { resolveProvider } from "./provider";
import { createScheduleStore, type Schedule, type ScheduleStore } from "./schedules";
import { createScheduler, type Scheduler } from "./scheduler";
import { createScheduleTools } from "./schedule-tools";
import { renderScheduleList, buildScheduleKeyboard, parseCallback } from "./schedule-ui";
import { createWeatherTool } from "./weather";
import { createSettingsStore, type SettingsStore } from "./settings";
import { createSettingsTools, resolveEffective, renderSettings } from "./settings-tools";
import { geocode } from "./geocode";
import { createTranscriptLogger, type TranscriptLogger } from "./transcript";
import { plannerAgent, recipeAgent, librarianAgent, pickTools } from "./agents";
import { createRecipeTool } from "./recipe-tool";
import { createLibrarianTool } from "./librarian-tool";
import { createRecallTool } from "./recall";
import { createPlanStore } from "./plan-draft";
import { createPlanTools } from "./plan-tools";
import { renderPlanCard, buildPlanKeyboard, parsePlanCallback } from "./meal-plan-ui";
import { createDeployStore } from "./deploy-state";
import { announceUpdates } from "./release-notes";
import { RELEASES } from "./releases";

const REPLY_CHUNK_SIZE = 4000;

/**
 * Compose the full system prompt for a turn: the deployment's base prompt
 * (configurable via SYSTEM_PROMPT) plus always-on runtime context the model
 * can't do without. Today the always-on layer is just the date — the Claude
 * Agent SDK used to supply this automatically; the plain AI SDK does not, so
 * without it the model can't reason about relative dates ("this week",
 * "today's meals"). Defaults to the process timezone (the TZ env var); a chat can
 * override it via its settings, passed in as `timeZone`.
 */
export function buildSystemPrompt(
  base: string,
  now: Date = new Date(),
  timeZone?: string,
  planDays?: number,
): string {
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZoneName: "short",
    timeZone,
  }).format(now);
  const planLine = planDays
    ? `\n\nWhen planning meals, plan ${planDays} days at a time unless the user asks for a different ` +
      `range, and use the present_meal_plan tool to show the plan as an interactive card.`
    : "";
  return `${base}\n\nToday's date is ${date}.${planLine}`;
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
  /** Resolve the model for a turn by slug (per-chat override), or the default. */
  modelFor: (slug?: string) => LanguageModel;
  /** MCP tools (plus any provider web-search tool); per-turn tools are merged on top. */
  tools: ToolSet;
  /**
   * Every connected MCP tool's (namespaced) name, for the `/tools` diagnostic.
   * The agents run on a scoped subset; this is the full catalog, used to decide
   * what to add to an agent's scope. Omitted in tests → `/tools` reports none.
   */
  mcpToolNames?: string[];
  /**
   * Per-chat settings. When provided, the bot wires the `/settings` commands and
   * settings agent tools, and resolves each turn's prompt/location/timezone/
   * model/steps against these overrides. Omitted in tests → deployment defaults.
   */
  settingsStore?: SettingsStore;
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
  /** Optional per-chat transcript logger; omitted (or no-op) when disabled. */
  transcript?: TranscriptLogger;
  /** Injectable fetch for downloading Telegram files (photos); defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/** Prompt used for a photo sent without a caption. */
const DEFAULT_PHOTO_PROMPT =
  "Here's a photo. If it's a recipe, read its title, ingredients, and steps and offer to save it " +
  "to our Mealie library; otherwise tell me what it is and how it relates to meal planning.";

/** Best-effort image media type from a Telegram file path's extension. */
function mediaTypeForPath(path: string): string {
  switch (path.toLowerCase().split(".").pop()) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "heic":
      return "image/heic";
    default:
      return "image/jpeg";
  }
}

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.config.telegramToken);

  // Staged meal-plan draft cards (in-memory; ephemeral until locked in).
  const planStore = createPlanStore();

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
   * Run one agent turn for a chat and deliver the reply. Resolves the chat's
   * effective settings (prompt, location, timezone, model, step cap) first, then
   * builds the per-chat tools (weather uses the chat's location; schedule and
   * settings tools are bound to the chat) on top of the shared base tools.
   * `useSession` threads the chat's live conversation (and persists the result);
   * scheduled "fresh" runs pass false to stay isolated.
   */
  async function runTurn(args: {
    chatId: number;
    prompt: string;
    useSession: boolean;
    trigger: "message" | "schedule";
    /** Image attachments for a vision turn (a photo the user sent). */
    images?: { data: Uint8Array; mediaType: string }[];
  }): Promise<void> {
    const priorMessages = args.useSession ? (deps.sessionStore.get(args.chatId) ?? []) : [];
    // Operational breadcrumb: shows whether a chat's history is actually being
    // resumed turn-to-turn (vs. silently starting fresh from idle expiry or a
    // wiped/unmounted store). Watch this in the bot logs when context goes missing.
    if (args.useSession) {
      console.log(
        `Turn for chat ${args.chatId}: ${priorMessages.length} prior message(s) — ` +
          `${priorMessages.length > 0 ? "resumed" : "fresh"} session.`,
      );
    }
    const settings = deps.settingsStore?.get(args.chatId) ?? {};
    const eff = resolveEffective(deps.config, settings);

    const weatherTools = createWeatherTool({ defaultLat: eff.lat, defaultLong: eff.long });
    const planTools = createPlanTools({
      api: bot.api,
      chatId: args.chatId,
      store: planStore,
      lat: eff.lat,
      long: eff.long,
    });
    const scheduleTools =
      deps.store && scheduler
        ? createScheduleTools({
            store: deps.store,
            scheduler,
            chatId: args.chatId,
            defaultTimezone: eff.timezone,
          })
        : {};
    const settingsTools = deps.settingsStore
      ? createSettingsTools({ store: deps.settingsStore, chatId: args.chatId, defaults: deps.config })
      : {};
    // Recall over past sessions, when transcript logging (its data source) is on.
    const recallTools = deps.config.transcriptDir
      ? createRecallTool({
          chatId: args.chatId,
          dir: deps.config.transcriptDir,
          currentSessionId: args.useSession ? deps.sessionStore.sessionId(args.chatId) : undefined,
        })
      : {};

    const startedAt = Date.now();
    const result = await deps.ask({
      messages: priorMessages,
      prompt: args.prompt,
      systemPrompt: buildSystemPrompt(eff.systemPrompt, new Date(), eff.timezone, eff.planDays),
      model: deps.modelFor(eff.modelSlug),
      tools: { ...deps.tools, ...weatherTools, ...planTools, ...scheduleTools, ...settingsTools, ...recallTools },
      maxSteps: eff.maxSteps,
      images: args.images,
    });
    // Persisting returns the session id these messages belong to; an isolated
    // (fresh scheduled) run has no stored session, so give it a standalone id.
    const sessionId = args.useSession
      ? await deps.sessionStore.set(args.chatId, result.messages)
      : newSessionId();

    // If the turn hit the step cap mid-tool-use, say so instead of sending an
    // empty/partial reply with no explanation. The full step history is persisted
    // above, so "continue" resumes from where it stopped.
    const replyText = result.truncated
      ? `${result.text ? `${result.text}\n\n` : ""}⚠️ I hit my step limit partway through, so this may be unfinished. Say “continue” and I’ll pick up where I left off.`
      : result.text;
    await sendReply(bot.api, args.chatId, replyText);

    // Append the turn to the transcript log (no-op when disabled; never throws).
    await deps.transcript?.log({
      ts: new Date().toISOString(),
      chatId: args.chatId,
      sessionId,
      trigger: args.trigger,
      fresh: priorMessages.length === 0,
      priorMessages: priorMessages.length,
      prompt: args.prompt,
      reply: replyText,
      tools: result.toolCalls ?? [],
      model: eff.modelSlug ?? deps.config.model,
      usage: result.usage,
      steps: result.steps,
      truncated: result.truncated,
      ms: Date.now() - startedAt,
    });
  }

  bot.command("plan", async (ctx) => {
    await ctx.replyWithChatAction("typing");
    try {
      await runTurn({
        chatId: ctx.chat.id,
        prompt: "Plan our upcoming dinners and show me the interactive plan card.",
        useSession: true,
        trigger: "message",
      });
    } catch (err) {
      console.error(
        `/plan turn failed for chat ${ctx.chat.id}:`,
        err instanceof Error ? err.message : err,
      );
      await ctx.reply(errorReplyFor(err));
    }
  });

  bot.command("librarian", async (ctx) => {
    const task = ctx.match.trim();
    if (!task) {
      await ctx.reply(
        "Usage: /librarian <task> — hand a recipe-library job to the librarian, e.g.\n" +
          "/librarian clean up any recipes that need it\n" +
          "/librarian fix the ingredients on the Butter Chicken recipe\n" +
          "(You can also just ask me in plain language.)",
      );
      return;
    }
    await ctx.replyWithChatAction("typing");
    try {
      await runTurn({
        chatId: ctx.chat.id,
        prompt: `Use the recipe librarian (tidy_recipe_library) to handle this: ${task}`,
        useSession: true,
        trigger: "message",
      });
    } catch (err) {
      console.error(
        `/librarian turn failed for chat ${ctx.chat.id}:`,
        err instanceof Error ? err.message : err,
      );
      await ctx.reply(errorReplyFor(err));
    }
  });

  // Diagnostic: list every connected MCP tool (the full catalog). The agents run
  // on a scoped subset; this is how you see what's available to add to a scope.
  bot.command("tools", async (ctx) => {
    const names = deps.mcpToolNames ?? [];
    if (names.length === 0) {
      await ctx.reply("No MCP tools are connected.");
      return;
    }
    const body = [...names].sort().join("\n");
    await sendReply(bot.api, ctx.chat.id, `Connected MCP tools (${names.length}):\n\n${body}`);
  });

  if (deps.settingsStore) {
    const settingsStore = deps.settingsStore;

    bot.command("setdays", async (ctx) => {
      const n = Number(ctx.match.trim());
      if (!Number.isInteger(n) || n < 1 || n > 14) {
        await ctx.reply("Usage: /setdays <1-14> — how many days to plan meals for.");
        return;
      }
      await settingsStore.update(ctx.chat.id, { planDays: n });
      await ctx.reply(renderSettings(deps.config, settingsStore.get(ctx.chat.id)));
    });

    bot.command("settings", async (ctx) => {
      await ctx.reply(renderSettings(deps.config, settingsStore.get(ctx.chat.id)));
    });

    bot.command("setlocation", async (ctx) => {
      const place = ctx.match.trim();
      if (!place) {
        await ctx.reply("Usage: /setlocation <place> — e.g. /setlocation Nanaimo, BC");
        return;
      }
      let hit;
      try {
        hit = await geocode(place);
      } catch (err) {
        await ctx.reply(`Location lookup failed: ${err instanceof Error ? err.message : err}`);
        return;
      }
      if (!hit) {
        await ctx.reply(`Couldn't find a location named "${place}".`);
        return;
      }
      // Adopt the place's timezone too (undefined is ignored by the store).
      await settingsStore.update(ctx.chat.id, {
        location: { name: hit.name, lat: hit.lat, long: hit.long },
        timezone: hit.timezone,
      });
      await ctx.reply(renderSettings(deps.config, settingsStore.get(ctx.chat.id)));
    });

    bot.command("setprompt", async (ctx) => {
      const text = ctx.match.trim();
      if (!text) {
        await ctx.reply("Usage: /setprompt <system prompt text>");
        return;
      }
      await settingsStore.update(ctx.chat.id, { systemPrompt: text });
      await ctx.reply("System prompt updated for this chat.");
    });

    bot.command("resetsettings", async (ctx) => {
      await settingsStore.clear(ctx.chat.id);
      await ctx.reply(`Settings reset to defaults.\n\n${renderSettings(deps.config, settingsStore.get(ctx.chat.id))}`);
    });
  }

  if (deps.store && deps.makeScheduler) {
    const store = deps.store;

    scheduler = deps.makeScheduler(async (schedule) => {
      try {
        await runTurn({
          chatId: schedule.chatId,
          prompt: schedule.prompt,
          useSession: schedule.sessionMode === "continue",
          trigger: "schedule",
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

  }

  // Single callback-query dispatcher: meal-plan cards first, then (if scheduling
  // is wired) the schedule control panel. Registered unconditionally so plan-card
  // buttons work even in a deployment without the scheduler.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const chatId = ctx.chat?.id;

    const plan = parsePlanCallback(data);
    if (plan) {
      const draft = planStore.get(plan.id);
      if (chatId === undefined || !draft || draft.chatId !== chatId) {
        await ctx.answerCallbackQuery({ text: "This plan is no longer active." });
        return;
      }
      if (draft.committed) {
        await ctx.answerCallbackQuery({ text: "This plan is already saved." });
        return;
      }

      switch (plan.action) {
        case "shuffle":
          planStore.shuffle(plan.id, plan.dayIndex!);
          await ctx.answerCallbackQuery();
          break;
        case "skip":
          planStore.skip(plan.id, plan.dayIndex!);
          await ctx.answerCallbackQuery({ text: "Skipped." });
          break;
        case "unskip":
          planStore.unskip(plan.id, plan.dayIndex!);
          await ctx.answerCallbackQuery();
          break;
        case "all":
          planStore.shuffleAll(plan.id);
          await ctx.answerCallbackQuery({ text: "Shuffled." });
          break;
        case "lock": {
          planStore.commit(plan.id);
          await ctx.answerCallbackQuery({ text: "Saving to Mealie…" });
          // Mealie writes live in the agent, so hand the locked picks to a turn.
          // Note days become plain notes; recipe days name the chosen recipe.
          const picks = draft.days
            .map((d) =>
              d.note ? `- ${d.date}: NOTE: ${d.note}` : `- ${d.date}: ${d.candidates[d.chosen]?.title ?? ""}`,
            )
            .join("\n");
          void runTurn({
            chatId,
            prompt:
              "Save this dinner plan to Mealie — replace the dinner meal-plan entries for exactly " +
              `these dates:\n${picks}\n` +
              "For a day marked NOTE, add a note-type meal-plan entry with that text (no recipe). " +
              "For the others, use find_or_create_recipe for any dish that doesn't have a recipe yet, " +
              "then replace the week's meal plan for these dates. Do NOT present another plan card; " +
              "just confirm briefly when done.",
            useSession: true,
            trigger: "message",
          }).catch((err) => {
            console.error(
              `Meal-plan lock write failed for chat ${chatId}:`,
              err instanceof Error ? err.message : err,
            );
            void bot.api.sendMessage(chatId, errorReplyFor(err)).catch(() => {});
          });
          break;
        }
      }

      // Redraw the card in place; a committed draft drops its buttons. Editing
      // throws if nothing changed or the message is too old — harmless, so ignore.
      await ctx
        .editMessageText(renderPlanCard(draft), { reply_markup: buildPlanKeyboard(draft) })
        .catch(() => {});
      return;
    }

    if (deps.store && scheduler) {
      const store = deps.store;
      const parsed = parseCallback(data);
      if (!parsed) {
        await ctx.answerCallbackQuery();
        return;
      }
      const schedule = store.get(parsed.id);
      if (chatId === undefined || !schedule || schedule.chatId !== chatId) {
        await ctx.answerCallbackQuery({ text: "That schedule no longer exists." });
        return;
      }

      let note: string;
      switch (parsed.action) {
        case "run":
          void scheduler.runNow(parsed.id);
          note = "Running now…";
          break;
        case "pause":
          await store.update(parsed.id, { enabled: false });
          scheduler.sync(parsed.id);
          note = "Paused.";
          break;
        case "resume":
          await store.update(parsed.id, { enabled: true });
          scheduler.sync(parsed.id);
          note = "Resumed.";
          break;
        case "del":
          await store.remove(parsed.id);
          scheduler.sync(parsed.id);
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
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // Download a Telegram file (photo/document) to bytes for a vision turn. Two
  // steps: getFile resolves the file_path, then we fetch it from Telegram's file
  // endpoint (which needs the bot token in the URL).
  const doFetch = deps.fetchImpl ?? fetch;
  async function downloadTelegramImage(
    fileId: string,
    mimeHint?: string,
  ): Promise<{ data: Uint8Array; mediaType: string }> {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) throw new Error("Telegram returned no file_path for the image.");
    const url = `https://api.telegram.org/file/bot${deps.config.telegramToken}/${file.file_path}`;
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}.`);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mediaType: mimeHint || mediaTypeForPath(file.file_path),
    };
  }

  /** Shared handling for an inbound image (photo or image document). */
  async function handleImage(
    ctx: { chat: { id: number }; reply: (t: string) => Promise<unknown>; replyWithChatAction: (a: "typing") => Promise<unknown> },
    fileId: string,
    caption: string | undefined,
    mimeHint: string | undefined,
  ): Promise<void> {
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("typing");
    try {
      const image = await downloadTelegramImage(fileId, mimeHint);
      await runTurn({
        chatId,
        prompt: caption?.trim() || DEFAULT_PHOTO_PROMPT,
        images: [image],
        useSession: true,
        trigger: "message",
      });
    } catch (err) {
      console.error(`Image turn failed for chat ${chatId}:`, err instanceof Error ? err.message : err);
      await ctx.reply(errorReplyFor(err));
    }
  }

  // Photos: Telegram sends several sizes; the last is the largest.
  bot.on("message:photo", async (ctx) => {
    const largest = ctx.message.photo.at(-1);
    if (!largest) return;
    await handleImage(ctx, largest.file_id, ctx.message.caption, undefined);
  });

  // Documents: only image files (a recipe scan sent as a file rather than a photo).
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    if (!doc.mime_type?.startsWith("image/")) {
      await ctx.reply("I can read photos and image files. Send a recipe as a photo or an image file.");
      return;
    }
    await handleImage(ctx, doc.file_id, ctx.message.caption, doc.mime_type);
  });

  // Catch-all for ordinary (non-command) text — registered LAST so every command
  // handler above gets first crack at a "/…" message. grammY runs middleware in
  // registration order and command handlers don't call next(), so a command is
  // handled by its own handler; anything else falls through to here as a turn.
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    await ctx.replyWithChatAction("typing");
    try {
      await runTurn({ chatId, prompt: ctx.message.text, useSession: true, trigger: "message" });
    } catch (err) {
      console.error(
        `Agent turn failed for chat ${chatId}:`,
        err instanceof Error ? err.message : err,
      );
      await ctx.reply(errorReplyFor(err));
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

  const scheduleStore = createScheduleStore(config.scheduleFile);
  await scheduleStore.load();

  const settingsStore = createSettingsStore(config.settingsFile);
  await settingsStore.load();

  const transcript = createTranscriptLogger(config.transcriptDir);

  const { modelFor, webSearchTool } = resolveProvider(config);

  console.log("Connecting MCP servers...");
  const mcp = await createMcpTools(config.mcpServers, (line) => console.log(line));
  for (const line of mcp.describe()) {
    console.log(line);
  }

  // Scope the planner to the Mealie tools its task needs (not all ~130) — a
  // smaller, relevant tool surface makes the model's tool selection far more
  // reliable. The weather, schedule, and settings tools are built per turn (they
  // depend on the chat's location/id), so they're not here.
  const { tools: plannerMcpTools, missing } = pickTools(mcp.tools, plannerAgent.mcpTools);
  if (missing.length > 0) {
    console.log(`Planner: ${missing.length} scoped tool(s) not found on the server: ${missing.join(", ")}`);
  }
  console.log(
    `Planner scoped to ${Object.keys(plannerMcpTools).length} Mealie tools (of ${Object.keys(mcp.tools).length}).`,
  );

  // The recipe sub-agent: its own scoped Mealie tools, exposed to the planner as
  // the find_or_create_recipe tool (a nested, isolated agent turn).
  const { tools: recipeMcpTools, missing: recipeMissing } = pickTools(mcp.tools, recipeAgent.mcpTools);
  if (recipeMissing.length > 0) {
    console.log(`Recipe agent: ${recipeMissing.length} scoped tool(s) not found: ${recipeMissing.join(", ")}`);
  }
  const recipeTool = createRecipeTool({ ask: realAsk, modelFor, tools: recipeMcpTools, agent: recipeAgent });

  // The librarian sub-agent: recipe-library upkeep (cleanup, enrich, import),
  // exposed to the planner as the tidy_recipe_library tool.
  const { tools: librarianMcpTools, missing: librarianMissing } = pickTools(mcp.tools, librarianAgent.mcpTools);
  if (librarianMissing.length > 0) {
    console.log(`Librarian: ${librarianMissing.length} scoped tool(s) not found: ${librarianMissing.join(", ")}`);
  }
  const librarianTool = createLibrarianTool({ ask: realAsk, modelFor, tools: librarianMcpTools, agent: librarianAgent });

  const tools: ToolSet = {
    ...plannerMcpTools,
    ...recipeTool,
    ...librarianTool,
    ...(webSearchTool ? { web_search: webSearchTool } : {}),
  };
  console.log(
    `Model: ${config.provider}/${config.model}; web search ${config.webSearch ? "on" : "off"}; ` +
      `transcript log ${config.transcriptDir ? `→ ${config.transcriptDir}` : "off"}.`,
  );

  let scheduler: Scheduler | undefined;
  const bot = createBot({
    config,
    sessionStore,
    ask: realAsk,
    modelFor,
    tools,
    mcpToolNames: Object.keys(mcp.tools),
    settingsStore,
    transcript,
    store: scheduleStore,
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
      { command: "plan", description: "Plan meals & show an interactive plan card" },
      { command: "librarian", description: "Ask the librarian to tidy the recipe library" },
      { command: "schedules", description: "List & manage scheduled prompts" },
      { command: "settings", description: "Show this chat's settings" },
      { command: "setdays", description: "Set how many days to plan meals for" },
      { command: "setlocation", description: "Set the household's location" },
      { command: "setprompt", description: "Set a custom system prompt for this chat" },
      { command: "resetsettings", description: "Revert settings to defaults" },
      { command: "reset", description: "Start a fresh conversation" },
    ])
    .catch((err) => console.error("setMyCommands failed:", err instanceof Error ? err.message : err));

  const runner = run(bot);
  console.log("House bot running (long polling).");

  // Deploy notes: if this build's top release version is newer than what we last
  // announced (persisted in the data volume), post the release notes to each
  // allowed chat. Best-effort — never let it hold up or crash startup. The marker
  // path is logged (absolute) so you can confirm it's landing in the mounted data
  // volume; if it reads "none" on every boot, the volume isn't persisting.
  try {
    const deployStore = createDeployStore(config.deployStateFile);
    await deployStore.load();
    const markerPath = resolve(config.deployStateFile);
    console.log(`Deploy marker: ${markerPath} → last announced ${deployStore.get() ?? "none"}.`);
    const announced = await announceUpdates({
      releases: RELEASES,
      lastAnnounced: deployStore.get(),
      chatIds: config.allowedChatIds,
      persist: async (version) => {
        await deployStore.set(version);
        console.log(`Deploy marker written: ${version} → ${markerPath}.`);
      },
      send: async (chatId, markdownV2, plain) => {
        try {
          await bot.api.sendMessage(chatId, markdownV2, { parse_mode: "MarkdownV2" });
        } catch (err) {
          console.error(
            `Release-notes MarkdownV2 rejected for chat ${chatId}, sending plain:`,
            err instanceof Error ? err.message : err,
          );
          await bot.api.sendMessage(chatId, plain).catch(() => {});
        }
      },
    });
    if (announced.length > 0) {
      console.log(`Announced ${announced.length} release(s) to ${config.allowedChatIds.size} chat(s).`);
    }
  } catch (err) {
    console.error("Release-notes announcement failed:", err instanceof Error ? err.message : err);
  }

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
