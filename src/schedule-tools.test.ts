import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { createScheduleStore, type ScheduleStore } from "./schedules";
import type { Scheduler } from "./scheduler";
import { createScheduleTools } from "./schedule-tools";

function tempStore(): ScheduleStore {
  const dir = mkdtempSync(join(tmpdir(), "house-bot-schedule-tools-"));
  return createScheduleStore(join(dir, "schedules.json"));
}

/** Records scheduler.sync calls; the tools only need sync/runNow to exist. */
function fakeScheduler() {
  const synced: string[] = [];
  const scheduler: Scheduler = {
    start: async () => {},
    sync: (id) => void synced.push(id),
    runNow: async () => {},
    stop: () => {},
  };
  return { scheduler, synced };
}

// The tools are invoked directly, bypassing the model; a bare options object
// satisfies the AI SDK's execute signature.
const call = (tools: ToolSet, name: string, args: unknown) =>
  (tools[name]!.execute as (a: unknown, o: unknown) => Promise<any>)(args, {
    toolCallId: "t",
    messages: [],
  });

async function setup(chatId = 100) {
  const store = tempStore();
  await store.load();
  const { scheduler, synced } = fakeScheduler();
  const tools = createScheduleTools({ store, scheduler, chatId, defaultTimezone: "UTC" });
  return { store, tools, synced, chatId };
}

describe("create_schedule", () => {
  test("creates a schedule, syncs the scheduler, and stamps the chat + timezone", async () => {
    const { store, tools, synced, chatId } = await setup();
    const res = await call(tools, "create_schedule", {
      kind: "recurring",
      cron: "0 17 * * 0",
      prompt: "plan meals",
    });
    expect(res.ok).toBe(true);
    const stored = store.list(chatId);
    expect(stored.length).toBe(1);
    expect(stored[0]?.timezone).toBe("UTC");
    expect(synced).toEqual([stored[0]!.id]);
  });

  test("rejects an invalid cron expression without creating anything", async () => {
    const { store, tools } = await setup();
    const res = await call(tools, "create_schedule", {
      kind: "recurring",
      cron: "nonsense",
      prompt: "x",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Invalid cron");
    expect(store.list().length).toBe(0);
  });

  test("creates a one-off with a future datetime", async () => {
    const { store, tools, chatId } = await setup();
    const res = await call(tools, "create_schedule", {
      kind: "once",
      runAt: "2099-01-01T09:00:00",
      prompt: "one-time reminder",
    });
    expect(res.ok).toBe(true);
    const stored = store.list(chatId);
    expect(stored[0]?.kind).toBe("once");
  });

  test("rejects a one-off in the past", async () => {
    const { store, tools } = await setup();
    const res = await call(tools, "create_schedule", {
      kind: "once",
      runAt: "2000-01-01T09:00:00",
      prompt: "too late",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("past");
    expect(store.list().length).toBe(0);
  });
});

describe("list_schedules", () => {
  test("returns only this chat's schedules", async () => {
    const { store, tools, chatId } = await setup();
    await store.add({ kind: "recurring", chatId, cron: "0 0 * * *", prompt: "mine" });
    await store.add({ kind: "recurring", chatId: 999, cron: "0 0 * * *", prompt: "theirs" });
    const res = await call(tools, "list_schedules", {});
    expect(res.schedules.map((s: { prompt: string }) => s.prompt)).toEqual(["mine"]);
  });
});

describe("ownership enforcement", () => {
  test("delete refuses a schedule owned by another chat", async () => {
    const { store, tools } = await setup(100);
    const other = await store.add({ kind: "recurring", chatId: 200, cron: "0 0 * * *", prompt: "theirs" });
    const res = await call(tools, "delete_schedule", { id: other.id });
    expect(res.ok).toBe(false);
    expect(store.get(other.id)).toBeDefined();
  });

  test("toggle refuses a schedule owned by another chat", async () => {
    const { store, tools } = await setup(100);
    const other = await store.add({ kind: "recurring", chatId: 200, cron: "0 0 * * *", prompt: "theirs" });
    const res = await call(tools, "toggle_schedule", { id: other.id, enabled: false });
    expect(res.ok).toBe(false);
    expect(store.get(other.id)?.enabled).toBe(true);
  });

  test("toggle and delete work on this chat's own schedule", async () => {
    const { store, tools, chatId } = await setup(100);
    const mine = await store.add({ kind: "recurring", chatId, cron: "0 0 * * *", prompt: "mine" });
    expect((await call(tools, "toggle_schedule", { id: mine.id, enabled: false })).ok).toBe(true);
    expect(store.get(mine.id)?.enabled).toBe(false);
    expect((await call(tools, "delete_schedule", { id: mine.id })).ok).toBe(true);
    expect(store.get(mine.id)).toBeUndefined();
  });
});
