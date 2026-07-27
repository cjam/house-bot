import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduleStore, type Schedule } from "./schedules";
import { createScheduler, validateCron, validateOnce, nextRun } from "./scheduler";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "house-bot-scheduler-"));
  return createScheduleStore(join(dir, "schedules.json"));
}

const DAY = 24 * 60 * 60_000;

describe("validateCron", () => {
  test("accepts a valid 5-field expression", () => {
    expect(validateCron("0 17 * * 0")).toBeNull();
  });

  test("rejects a malformed expression", () => {
    expect(validateCron("not a cron")).not.toBeNull();
  });

  test("rejects an unknown timezone", () => {
    expect(validateCron("0 0 * * *", "Mars/Phobos")).not.toBeNull();
  });
});

describe("nextRun", () => {
  test("computes the next occurrence after a given time", () => {
    const schedule = { kind: "recurring", cron: "0 0 * * *", timezone: "UTC" } as Schedule;
    const next = nextRun(schedule, new Date("2026-07-27T05:00:00Z"));
    expect(next?.toISOString()).toBe("2026-07-28T00:00:00.000Z");
  });
});

describe("createScheduler catch-up on start", () => {
  test("fires a run missed while the process was down", async () => {
    const store = tempStore();
    await store.load();
    // Daily at noon UTC, last ran two days ago → an occurrence was missed.
    const s = await store.add({ kind: "recurring", chatId: 1, cron: "0 12 * * *", prompt: "hi", timezone: "UTC" });
    await store.update(s.id, { lastRunAt: Date.now() - 2 * DAY });

    const fired: Schedule[] = [];
    const scheduler = createScheduler({ store, onFire: async (sc) => void fired.push(sc) });
    await scheduler.start();
    scheduler.stop();

    expect(fired.map((f) => f.id)).toEqual([s.id]);
    // lastRunAt is advanced so the next boot won't re-fire the same miss.
    expect(store.get(s.id)?.lastRunAt).toBeGreaterThan(Date.now() - DAY);
  });

  test("does not fire a schedule that has never run", async () => {
    const store = tempStore();
    await store.load();
    await store.add({ kind: "recurring", chatId: 1, cron: "0 12 * * *", prompt: "hi", timezone: "UTC" });

    const fired: Schedule[] = [];
    const scheduler = createScheduler({ store, onFire: async (sc) => void fired.push(sc) });
    await scheduler.start();
    scheduler.stop();

    expect(fired).toEqual([]);
  });

  test("does not fire when no occurrence has elapsed since the last run", async () => {
    const store = tempStore();
    await store.load();
    const s = await store.add({ kind: "recurring", chatId: 1, cron: "0 12 * * *", prompt: "hi", timezone: "UTC" });
    await store.update(s.id, { lastRunAt: Date.now() - 60_000 }); // a minute ago

    const fired: Schedule[] = [];
    const scheduler = createScheduler({ store, onFire: async (sc) => void fired.push(sc) });
    await scheduler.start();
    scheduler.stop();

    expect(fired).toEqual([]);
  });

  test("ignores disabled schedules", async () => {
    const store = tempStore();
    await store.load();
    const s = await store.add({ kind: "recurring", chatId: 1, cron: "0 12 * * *", prompt: "hi", timezone: "UTC" });
    await store.update(s.id, { enabled: false, lastRunAt: Date.now() - 2 * DAY });

    const fired: Schedule[] = [];
    const scheduler = createScheduler({ store, onFire: async (sc) => void fired.push(sc) });
    await scheduler.start();
    scheduler.stop();

    expect(fired).toEqual([]);
  });
});

describe("validateOnce", () => {
  test("accepts a future datetime", () => {
    expect(validateOnce("2099-01-01T00:00:00", "UTC")).toBeNull();
  });

  test("rejects a past datetime", () => {
    expect(validateOnce("2000-01-01T00:00:00", "UTC")).toContain("past");
  });

  test("rejects a malformed datetime", () => {
    expect(validateOnce("not-a-date")).not.toBeNull();
  });
});

describe("createScheduler one-off handling", () => {
  test("fires a one-off missed while down, then deletes it", async () => {
    const store = tempStore();
    await store.load();
    const s = await store.add({
      kind: "once",
      chatId: 1,
      runAt: "2000-01-01T00:00:00", // already past, never ran
      prompt: "hi",
      timezone: "UTC",
    });

    const fired: Schedule[] = [];
    const scheduler = createScheduler({ store, onFire: async (sc) => void fired.push(sc) });
    await scheduler.start();
    scheduler.stop();

    expect(fired.map((f) => f.id)).toEqual([s.id]);
    expect(store.get(s.id)).toBeUndefined(); // auto-deleted after firing
  });

  test("drops a leftover one-off that already ran without re-firing", async () => {
    const store = tempStore();
    await store.load();
    const s = await store.add({
      kind: "once",
      chatId: 1,
      runAt: "2000-01-01T00:00:00",
      prompt: "hi",
      timezone: "UTC",
    });
    await store.update(s.id, { lastRunAt: Date.now() - DAY });

    const fired: Schedule[] = [];
    const scheduler = createScheduler({ store, onFire: async (sc) => void fired.push(sc) });
    await scheduler.start();
    scheduler.stop();

    expect(fired).toEqual([]);
    expect(store.get(s.id)).toBeUndefined();
  });

  test("keeps a future one-off registered without firing it on start", async () => {
    const store = tempStore();
    await store.load();
    const s = await store.add({
      kind: "once",
      chatId: 1,
      runAt: "2099-01-01T00:00:00",
      prompt: "hi",
      timezone: "UTC",
    });

    const fired: Schedule[] = [];
    const scheduler = createScheduler({ store, onFire: async (sc) => void fired.push(sc) });
    await scheduler.start();
    scheduler.stop();

    expect(fired).toEqual([]);
    expect(store.get(s.id)).toBeDefined();
  });

  test("runNow fires a one-off and deletes it", async () => {
    const store = tempStore();
    await store.load();
    const s = await store.add({
      kind: "once",
      chatId: 1,
      runAt: "2099-01-01T00:00:00",
      prompt: "hi",
      timezone: "UTC",
    });

    const fired: Schedule[] = [];
    const scheduler = createScheduler({ store, onFire: async (sc) => void fired.push(sc) });
    await scheduler.runNow(s.id);
    scheduler.stop();

    expect(fired.map((f) => f.id)).toEqual([s.id]);
    expect(store.get(s.id)).toBeUndefined();
  });
});

describe("createScheduler runNow", () => {
  test("fires immediately regardless of enabled state and stamps lastRunAt", async () => {
    const store = tempStore();
    await store.load();
    const s = await store.add({ kind: "recurring", chatId: 1, cron: "0 0 1 1 *", prompt: "hi", enabled: false });

    const fired: Schedule[] = [];
    const scheduler = createScheduler({ store, onFire: async (sc) => void fired.push(sc) });
    await scheduler.runNow(s.id);
    scheduler.stop();

    expect(fired.map((f) => f.id)).toEqual([s.id]);
    expect(store.get(s.id)?.lastRunAt).not.toBeNull();
  });

  test("swallows a throwing onFire and leaves lastRunAt untouched", async () => {
    const store = tempStore();
    await store.load();
    const s = await store.add({ kind: "recurring", chatId: 1, cron: "0 0 1 1 *", prompt: "hi" });

    const logs: string[] = [];
    const scheduler = createScheduler({
      store,
      onFire: async () => {
        throw new Error("boom");
      },
      log: (l) => logs.push(l),
    });

    await expect(scheduler.runNow(s.id)).resolves.toBeUndefined();
    scheduler.stop();

    expect(store.get(s.id)?.lastRunAt).toBeNull();
    expect(logs.join("\n")).toContain("boom");
  });
});
