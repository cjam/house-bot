import { describe, expect, test } from "bun:test";
import type { Update } from "grammy/types";
import { createBot, chunkText, errorReplyFor } from "./index";
import { createSessionStore } from "./sessions";
import type { AskParams, AskResult } from "./agent";
import type { Config } from "./config";

describe("errorReplyFor", () => {
  test("gives a rate-limit-specific message for 429 / rate limit errors", () => {
    const msg = errorReplyFor(new Error("Request rejected (429) ... rate limit of 10,000 input tokens"));
    expect(msg.toLowerCase()).toContain("rate limit");
  });

  test("gives a generic message for other errors", () => {
    const msg = errorReplyFor(new Error("boom"));
    expect(msg.length).toBeGreaterThan(0);
    expect(msg.toLowerCase()).not.toContain("rate limit");
  });

  test("handles non-Error throwables", () => {
    expect(errorReplyFor("some string")).toBeTruthy();
  });
});

describe("chunkText", () => {
  test("returns the whole text in one chunk when under the limit", () => {
    expect(chunkText("hello", 4000)).toEqual(["hello"]);
  });

  test("splits text longer than the chunk size", () => {
    const text = "a".repeat(9000);
    const chunks = chunkText(text, 4000);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.length).toBe(4000);
    expect(chunks[2]?.length).toBe(1000);
    expect(chunks.join("")).toBe(text);
  });

  test("returns a single empty chunk for empty text", () => {
    expect(chunkText("", 4000)).toEqual([""]);
  });
});

const BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "HouseBot",
  username: "house_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegramToken: "test-token",
    allowedChatIds: new Set([100]),
    mcpServers: {},
    model: "claude-opus-4-8",
    sessionFile: "unused.json",
    ...overrides,
  };
}

function textUpdate(updateId: number, chatId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "Test" },
      from: { id: chatId, is_bot: false, first_name: "Test" },
      text,
    },
  } as unknown as Update;
}

function commandUpdate(updateId: number, chatId: number, command: string): Update {
  const update = textUpdate(updateId, chatId, command);
  (update as any).message.entities = [{ type: "bot_command", offset: 0, length: command.length }];
  return update;
}

async function tempSessionStore() {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "house-bot-index-"));
  const store = createSessionStore(join(dir, "sessions.json"));
  await store.load();
  return store;
}

describe("createBot allowlist", () => {
  test("silently ignores updates from chats not in the allowlist", async () => {
    const sentMessages: unknown[] = [];
    const askCalls: AskParams[] = [];
    const sessionStore = await tempSessionStore();

    const bot = createBot({
      config: baseConfig(),
      sessionStore,
      ask: async (params: AskParams): Promise<AskResult> => {
        askCalls.push(params);
        return { sessionId: "s1", text: "reply" };
      },
      systemPrompt: "be helpful",
    });
    bot.botInfo = BOT_INFO;
    bot.api.config.use((_prev, method, payload) => {
      sentMessages.push({ method, payload });
      return Promise.resolve({ ok: true, result: true } as never);
    });

    await bot.handleUpdate(textUpdate(1, 999, "hello"));

    expect(askCalls.length).toBe(0);
    expect(sentMessages.length).toBe(0);
  });

  test("processes updates from allowed chats", async () => {
    const sentMessages: unknown[] = [];
    const askCalls: AskParams[] = [];
    const sessionStore = await tempSessionStore();

    const bot = createBot({
      config: baseConfig(),
      sessionStore,
      ask: async (params: AskParams): Promise<AskResult> => {
        askCalls.push(params);
        return { sessionId: "s1", text: "reply" };
      },
      systemPrompt: "be helpful",
    });
    bot.botInfo = BOT_INFO;
    bot.api.config.use((_prev, method, payload) => {
      sentMessages.push({ method, payload });
      return Promise.resolve({ ok: true, result: true } as never);
    });

    await bot.handleUpdate(textUpdate(1, 100, "hello"));

    expect(askCalls.length).toBe(1);
    expect(sentMessages.some((m: any) => m.method === "sendMessage")).toBe(true);
  });

  test("catches a failing agent turn, replies with an error, and does not persist a session", async () => {
    const sentMessages: any[] = [];
    const sessionStore = await tempSessionStore();

    const bot = createBot({
      config: baseConfig(),
      sessionStore,
      ask: async (): Promise<AskResult> => {
        throw new Error("Request rejected (429) rate limit exceeded");
      },
      systemPrompt: "be helpful",
    });
    bot.botInfo = BOT_INFO;
    bot.api.config.use((_prev, method, payload) => {
      sentMessages.push({ method, payload });
      return Promise.resolve({ ok: true, result: true } as never);
    });

    // Must not reject out of the handler (that would trigger grammY's default
    // error handler and dump the whole context object).
    await expect(bot.handleUpdate(textUpdate(1, 100, "hello"))).resolves.toBeUndefined();

    const replies = sentMessages.filter((m) => m.method === "sendMessage");
    expect(replies.length).toBeGreaterThan(0);
    expect(String(replies[replies.length - 1].payload.text).toLowerCase()).toContain("rate limit");
    expect(sessionStore.get(100)).toBeUndefined();
  });
});

describe("createBot /reset", () => {
  test("clears the session for the current chat", async () => {
    const sessionStore = await tempSessionStore();
    await sessionStore.set(100, "old-session-id");

    const bot = createBot({
      config: baseConfig(),
      sessionStore,
      ask: async (): Promise<AskResult> => ({ sessionId: "s1", text: "reply" }),
      systemPrompt: "be helpful",
    });
    bot.botInfo = BOT_INFO;
    bot.api.config.use((_prev, _method, _payload) => {
      return Promise.resolve({ ok: true, result: true } as never);
    });

    await bot.handleUpdate(commandUpdate(1, 100, "/reset"));

    expect(sessionStore.get(100)).toBeUndefined();
  });
});
