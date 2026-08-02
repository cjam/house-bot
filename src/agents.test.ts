import { describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import { pickTools, plannerAgent } from "./agents";

const fakeTools = (names: string[]): ToolSet =>
  Object.fromEntries(names.map((n) => [n, { description: n } as any]));

describe("pickTools", () => {
  test("selects the requested tools and reports missing ones", () => {
    const all = fakeTools(["a", "b", "c"]);
    const { tools, missing } = pickTools(all, ["a", "c", "z"]);
    expect(Object.keys(tools).sort()).toEqual(["a", "c"]);
    expect(missing).toEqual(["z"]);
  });

  test("returns an empty set (not a throw) when nothing matches", () => {
    const { tools, missing } = pickTools(fakeTools(["x"]), ["a", "b"]);
    expect(Object.keys(tools)).toEqual([]);
    expect(missing).toEqual(["a", "b"]);
  });
});

describe("plannerAgent", () => {
  test("is a much smaller surface than the full Mealie tool set", () => {
    // Guards against accidentally scoping the planner back up to everything.
    expect(plannerAgent.mcpTools.length).toBeGreaterThan(10);
    expect(plannerAgent.mcpTools.length).toBeLessThan(40);
  });

  test("includes the core meal-plan, recipe-search, and shopping tools", () => {
    for (const key of [
      "mealie_get_mealplans",
      "mealie_replace_week_meal_plan",
      "mealie_get_all_api_recipes_get",
      "mealie_get_shopping_list_items",
    ]) {
      expect(plannerAgent.mcpTools).toContain(key);
    }
  });
});
