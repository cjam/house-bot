import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduleStore, type ScheduleInput } from "./schedules";

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "house-bot-schedules-"));
  return join(dir, "schedules.json");
}

const input = (over: Partial<ScheduleInput> = {}): ScheduleInput =>
  ({
    kind: "recurring",
    chatId: 100,
    cron: "0 17 * * 0",
    prompt: "plan meals",
    ...over,
  }) as ScheduleInput;

describe("createScheduleStore", () => {
  test("add assigns an id and sensible defaults", async () => {
    const store = createScheduleStore(tempFile());
    await store.load();
    const s = await store.add(input());
    expect(s.id).toMatch(/^[0-9a-f]{8}$/);
    expect(s.enabled).toBe(true);
    expect(s.sessionMode).toBe("fresh");
    expect(s.lastRunAt).toBeNull();
  });

  test("add honors explicit enabled/sessionMode/timezone", async () => {
    const store = createScheduleStore(tempFile());
    await store.load();
    const s = await store.add(
      input({ enabled: false, sessionMode: "continue", timezone: "America/Vancouver" }),
    );
    expect(s.enabled).toBe(false);
    expect(s.sessionMode).toBe("continue");
    expect(s.timezone).toBe("America/Vancouver");
  });

  test("adds a one-off schedule with kind and runAt", async () => {
    const store = createScheduleStore(tempFile());
    await store.load();
    const s = await store.add({
      kind: "once",
      chatId: 100,
      runAt: "2026-07-28T17:00:00",
      prompt: "remind me",
    });
    expect(s.kind).toBe("once");
    if (s.kind === "once") expect(s.runAt).toBe("2026-07-28T17:00:00");
  });

  test("load backfills kind='recurring' for legacy records without a kind", async () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ legacy: { chatId: 1, cron: "0 0 * * *", prompt: "hi" } }));
    const store = createScheduleStore(file);
    await store.load();
    expect(store.get("legacy")?.kind).toBe("recurring");
  });

  test("list filters by chat id and preserves insertion order", async () => {
    const store = createScheduleStore(tempFile());
    await store.load();
    const a = await store.add(input({ chatId: 1, prompt: "a" }));
    await store.add(input({ chatId: 2, prompt: "b" }));
    const c = await store.add(input({ chatId: 1, prompt: "c" }));
    expect(store.list(1).map((s) => s.id)).toEqual([a.id, c.id]);
    expect(store.list().length).toBe(3);
  });

  test("update patches fields and keeps the id", async () => {
    const store = createScheduleStore(tempFile());
    await store.load();
    const s = await store.add(input());
    const updated = await store.update(s.id, { enabled: false, lastRunAt: 123 });
    expect(updated?.id).toBe(s.id);
    expect(updated?.enabled).toBe(false);
    expect(updated?.lastRunAt).toBe(123);
    expect(store.get(s.id)?.enabled).toBe(false);
  });

  test("update returns undefined for an unknown id", async () => {
    const store = createScheduleStore(tempFile());
    await store.load();
    expect(await store.update("nope", { enabled: false })).toBeUndefined();
  });

  test("remove deletes and reports whether anything was removed", async () => {
    const store = createScheduleStore(tempFile());
    await store.load();
    const s = await store.add(input());
    expect(await store.remove(s.id)).toBe(true);
    expect(store.get(s.id)).toBeUndefined();
    expect(await store.remove(s.id)).toBe(false);
  });

  test("persists across reloads", async () => {
    const file = tempFile();
    const store = createScheduleStore(file);
    await store.load();
    const s = await store.add(input({ prompt: "persist me" }));

    const reopened = createScheduleStore(file);
    await reopened.load();
    expect(reopened.get(s.id)?.prompt).toBe("persist me");
  });

  test("load skips malformed records (no cron field)", async () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ good: { cron: "0 0 * * *" }, bad: { nope: 1 } }));
    const store = createScheduleStore(file);
    await store.load();
    const good = store.get("good");
    expect(good?.kind === "recurring" && good.cron).toBe("0 0 * * *");
    expect(store.get("bad")).toBeUndefined();
  });

  test("atomic write leaves no leftover tmp file", async () => {
    const file = tempFile();
    const store = createScheduleStore(file);
    await store.load();
    await store.add(input());
    const contents = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(contents).length).toBe(1);
  });
});
