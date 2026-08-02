import { describe, expect, test } from "bun:test";
import { createPlanStore, type PlanDayInput } from "./plan-draft";

const days: PlanDayInput[] = [
  { date: "2026-08-03", candidates: [{ title: "Fajitas" }, { title: "Tacos" }, { title: "Burritos" }] },
  { date: "2026-08-04", candidates: [{ title: "Curry" }] }, // single candidate
];

describe("createPlanStore", () => {
  test("create stages a draft with the first candidate chosen", () => {
    const store = createPlanStore();
    const draft = store.create(100, days);
    expect(draft.chatId).toBe(100);
    expect(draft.committed).toBe(false);
    expect(draft.days.map((d) => d.chosen)).toEqual([0, 0]);
    expect(store.get(draft.id)).toBe(draft);
  });

  test("shuffle advances one day's choice and wraps around", () => {
    const store = createPlanStore();
    const { id } = store.create(100, days);
    expect(store.shuffle(id, 0)?.days[0]?.chosen).toBe(1);
    expect(store.shuffle(id, 0)?.days[0]?.chosen).toBe(2);
    expect(store.shuffle(id, 0)?.days[0]?.chosen).toBe(0); // wraps
  });

  test("shuffle is a no-op for a single-candidate day", () => {
    const store = createPlanStore();
    const { id } = store.create(100, days);
    store.shuffle(id, 1);
    expect(store.get(id)?.days[1]?.chosen).toBe(0);
  });

  test("shuffleAll advances every multi-candidate day", () => {
    const store = createPlanStore();
    const { id } = store.create(100, days);
    store.shuffleAll(id);
    expect(store.get(id)?.days.map((d) => d.chosen)).toEqual([1, 0]);
  });

  test("commit marks the draft committed", () => {
    const store = createPlanStore();
    const { id } = store.create(100, days);
    expect(store.commit(id)?.committed).toBe(true);
    expect(store.get(id)?.committed).toBe(true);
  });

  test("skip sets a note (default when none given) and unskip clears it", () => {
    const store = createPlanStore();
    const { id } = store.create(100, days);
    store.skip(id, 0);
    expect(store.get(id)?.days[0]?.note).toBe("Eating out");
    store.skip(id, 1, "Pizza night");
    expect(store.get(id)?.days[1]?.note).toBe("Pizza night");
    store.unskip(id, 0);
    expect(store.get(id)?.days[0]?.note).toBeUndefined();
  });

  test("a day carries a note supplied at create time", () => {
    const store = createPlanStore();
    const draft = store.create(100, [{ date: "2026-08-05", candidates: [], note: "Leftovers" }]);
    expect(draft.days[0]?.note).toBe("Leftovers");
  });

  test("shuffleAll leaves skipped days untouched", () => {
    const store = createPlanStore();
    const { id } = store.create(100, days);
    store.skip(id, 0); // day 0 has multiple candidates but is now a note
    store.shuffleAll(id);
    expect(store.get(id)?.days[0]?.chosen).toBe(0);
  });

  test("operations on an unknown id return undefined", () => {
    const store = createPlanStore();
    expect(store.get("nope")).toBeUndefined();
    expect(store.shuffle("nope", 0)).toBeUndefined();
    expect(store.shuffleAll("nope")).toBeUndefined();
    expect(store.skip("nope", 0)).toBeUndefined();
    expect(store.unskip("nope", 0)).toBeUndefined();
    expect(store.commit("nope")).toBeUndefined();
  });

  test("distinct drafts get distinct ids", () => {
    const store = createPlanStore();
    expect(store.create(1, days).id).not.toBe(store.create(2, days).id);
  });
});
