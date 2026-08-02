import { describe, expect, test } from "bun:test";
import { createPlanStore, type PlanDayInput } from "./plan-draft";
import {
  renderPlanCard,
  buildPlanKeyboard,
  encodePlanCallback,
  parsePlanCallback,
} from "./meal-plan-ui";

const days: PlanDayInput[] = [
  {
    date: "2026-08-03", // a Monday
    candidates: [{ title: "Sheet-Pan Fajitas" }, { title: "Tacos" }],
    weather: { emoji: "☀️", highC: 24, lowC: 13, smoky: false },
  },
  {
    date: "2026-08-04",
    candidates: [{ title: "Thai Green Curry" }],
    weather: { emoji: "🌧️", highC: 18, lowC: 11, smoky: true },
  },
];

const draftOf = (over: Partial<{ committed: boolean }> = {}) => {
  const store = createPlanStore();
  const draft = store.create(100, days);
  if (over.committed) draft.committed = true;
  return draft;
};

describe("parsePlanCallback / encodePlanCallback", () => {
  test("round-trips a per-day shuffle", () => {
    expect(parsePlanCallback(encodePlanCallback("shuffle", "abc12345", 3))).toEqual({
      action: "shuffle",
      id: "abc12345",
      dayIndex: 3,
    });
  });

  test("round-trips skip/unskip day actions", () => {
    expect(parsePlanCallback(encodePlanCallback("skip", "abc12345", 1))).toEqual({
      action: "skip",
      id: "abc12345",
      dayIndex: 1,
    });
    expect(parsePlanCallback(encodePlanCallback("unskip", "abc12345", 2))).toEqual({
      action: "unskip",
      id: "abc12345",
      dayIndex: 2,
    });
  });

  test("round-trips whole-draft actions", () => {
    expect(parsePlanCallback(encodePlanCallback("all", "abc12345"))).toEqual({ action: "all", id: "abc12345" });
    expect(parsePlanCallback(encodePlanCallback("lock", "abc12345"))).toEqual({ action: "lock", id: "abc12345" });
  });

  test("rejects data that isn't ours or is malformed", () => {
    expect(parsePlanCallback("sch:run:abc")).toBeNull();
    expect(parsePlanCallback("mp:bogus:abc")).toBeNull();
    expect(parsePlanCallback("mp:shuffle:abc")).toBeNull(); // missing day index
    expect(parsePlanCallback("mp:shuffle:abc:x")).toBeNull(); // non-numeric day
    expect(parsePlanCallback("mp:lock:abc:0")).toBeNull(); // extra part
  });

  test("callback_data stays within Telegram's 64-byte limit", () => {
    expect(encodePlanCallback("shuffle", "a1b2c3d4", 13).length).toBeLessThanOrEqual(64);
  });
});

describe("renderPlanCard", () => {
  test("shows weekday+date, weather chip, and the chosen recipe per day", () => {
    const text = renderPlanCard(draftOf());
    expect(text).toContain("Mon, Aug 3");
    expect(text).toContain("☀️ 24°/13°");
    expect(text).toContain("Sheet-Pan Fajitas");
    expect(text).toContain("Tue, Aug 4");
    expect(text).toContain("🌧️ 18°/11° ⚠️"); // smoky day flagged
    expect(text).toContain("Thai Green Curry");
    expect(text).toContain("Lock it in");
  });

  test("reflects a shuffled choice", () => {
    const store = createPlanStore();
    const draft = store.create(100, days);
    store.shuffle(draft.id, 0);
    expect(renderPlanCard(draft)).toContain("Tacos");
  });

  test("shows a saved footer once committed", () => {
    const text = renderPlanCard(draftOf({ committed: true }));
    expect(text).toContain("Saved to Mealie");
    expect(text).not.toContain("Lock it in");
  });

  test("renders a skipped day's note instead of a recipe", () => {
    const store = createPlanStore();
    const draft = store.create(100, days);
    store.skip(draft.id, 0, "Pizza night");
    const text = renderPlanCard(draft);
    expect(text).toContain("📝 Pizza night");
    expect(text).not.toContain("Sheet-Pan Fajitas"); // recipe hidden while skipped
    expect(text).toContain("☀️ 24°/13°"); // weather still shown
  });
});

describe("buildPlanKeyboard", () => {
  test("emits shuffle (multi-candidate only) + skip per day, plus the action row", () => {
    const draft = draftOf();
    const kb = buildPlanKeyboard(draft);
    const datas = kb.inline_keyboard.flat().map((b) => (b as { callback_data: string }).callback_data);
    // Day 0 has two candidates → shuffle + skip; day 1 has one → skip only.
    expect(datas).toContain(encodePlanCallback("shuffle", draft.id, 0));
    expect(datas).not.toContain(encodePlanCallback("shuffle", draft.id, 1));
    expect(datas).toContain(encodePlanCallback("skip", draft.id, 0));
    expect(datas).toContain(encodePlanCallback("skip", draft.id, 1));
    expect(datas).toContain(encodePlanCallback("all", draft.id));
    expect(datas).toContain(encodePlanCallback("lock", draft.id));
  });

  test("a skipped day offers restore (when it has recipes) and no shuffle/skip", () => {
    const store = createPlanStore();
    const draft = store.create(100, days);
    store.skip(draft.id, 0);
    const datas = buildPlanKeyboard(draft)
      .inline_keyboard.flat()
      .map((b) => (b as { callback_data: string }).callback_data);
    expect(datas).toContain(encodePlanCallback("unskip", draft.id, 0));
    expect(datas).not.toContain(encodePlanCallback("shuffle", draft.id, 0));
    expect(datas).not.toContain(encodePlanCallback("skip", draft.id, 0));
  });

  test("a pure note day (no candidates) offers no restore button", () => {
    const store = createPlanStore();
    const draft = store.create(100, [{ date: "2026-08-03", candidates: [], note: "Eating out" }]);
    const datas = buildPlanKeyboard(draft)
      .inline_keyboard.flat()
      .map((b) => (b as { callback_data: string }).callback_data);
    expect(datas).not.toContain(encodePlanCallback("unskip", draft.id, 0));
    expect(datas).toContain(encodePlanCallback("lock", draft.id));
  });

  test("a committed draft has no buttons", () => {
    expect(buildPlanKeyboard(draftOf({ committed: true })).inline_keyboard.flat()).toHaveLength(0);
  });
});
