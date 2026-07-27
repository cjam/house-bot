import { describe, expect, test } from "bun:test";
import type { Schedule } from "./schedules";
import {
  renderScheduleList,
  buildScheduleKeyboard,
  parseCallback,
  encodeCallback,
} from "./schedule-ui";

const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  id: "a1b2c3d4",
  chatId: 100,
  cron: "0 17 * * 0",
  prompt: "Start planning next week's meal plan",
  enabled: true,
  sessionMode: "fresh",
  timezone: "UTC",
  createdAt: 0,
  lastRunAt: null,
  ...over,
});

describe("parseCallback / encodeCallback", () => {
  test("round-trips every action", () => {
    for (const action of ["run", "pause", "resume", "del"] as const) {
      expect(parseCallback(encodeCallback(action, "abc123"))).toEqual({ action, id: "abc123" });
    }
  });

  test("rejects data that isn't ours or is malformed", () => {
    expect(parseCallback("other:run:abc")).toBeNull();
    expect(parseCallback("sch:bogus:abc")).toBeNull();
    expect(parseCallback("sch:run")).toBeNull();
  });

  test("callback_data stays within Telegram's 64-byte limit", () => {
    expect(encodeCallback("resume", "a1b2c3d4").length).toBeLessThanOrEqual(64);
  });
});

describe("renderScheduleList", () => {
  test("shows an empty-state hint when there are none", () => {
    expect(renderScheduleList([])).toContain("No scheduled prompts");
  });

  test("numbers entries and shows state and prompt", () => {
    const text = renderScheduleList([schedule(), schedule({ id: "z", enabled: false })]);
    expect(text).toContain("Scheduled prompts (2)");
    expect(text).toContain("1. ▶️ enabled");
    expect(text).toContain("2. ⏸ paused");
    expect(text).toContain("Start planning next week");
  });
});

describe("buildScheduleKeyboard", () => {
  test("emits a run/pause/delete row per schedule", () => {
    const kb = buildScheduleKeyboard([schedule()]);
    const row = kb.inline_keyboard[0]!;
    expect(row.length).toBe(3);
    const datas = row.map((b) => (b as { callback_data: string }).callback_data);
    expect(datas).toEqual([
      encodeCallback("run", "a1b2c3d4"),
      encodeCallback("pause", "a1b2c3d4"),
      encodeCallback("del", "a1b2c3d4"),
    ]);
  });

  test("offers resume instead of pause for a disabled schedule", () => {
    const kb = buildScheduleKeyboard([schedule({ enabled: false })]);
    const datas = kb.inline_keyboard[0]!.map((b) => (b as { callback_data: string }).callback_data);
    expect(datas[1]).toBe(encodeCallback("resume", "a1b2c3d4"));
  });
});
