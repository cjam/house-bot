import { describe, expect, test } from "bun:test";
import { MAX_TOOL_NAME_LENGTH, shortenToolName } from "./tool-names";

describe("shortenToolName", () => {
  test("passes short names through unchanged", () => {
    const taken = new Set<string>();
    expect(shortenToolName("mealie_get_all_recipes", 51, taken)).toBe("mealie_get_all_recipes");
    expect(taken.has("mealie_get_all_recipes")).toBe(true);
  });

  test("shortens over-budget names to fit the budget", () => {
    const long = "mealie_add_single_recipe_ingredients_to_list_api_households_shopping";
    const short = shortenToolName(long, 51, new Set());
    expect(short.length).toBeLessThanOrEqual(51);
    // keeps a readable prefix of the original (server namespace + start of tool)
    expect(short.startsWith("mealie_add_single")).toBe(true);
  });

  test("distinct originals never collide, even sharing a prefix", () => {
    const budget = 51;
    const taken = new Set<string>();
    const a = "mealie_create_many_api_households_shopping_items_create_bulk_post_a";
    const b = "mealie_create_many_api_households_shopping_items_create_bulk_post_b";
    const sa = shortenToolName(a, budget, taken);
    const sb = shortenToolName(b, budget, taken);
    expect(sa).not.toBe(sb);
    expect(sa.length).toBeLessThanOrEqual(budget);
    expect(sb.length).toBeLessThanOrEqual(budget);
  });

  test("disambiguates a duplicate short name that is already taken", () => {
    const taken = new Set<string>(["mealie_get_all_recipes"]);
    const short = shortenToolName("mealie_get_all_recipes", 51, taken);
    expect(short).not.toBe("mealie_get_all_recipes");
    expect(short.length).toBeLessThanOrEqual(51);
  });

  test("respects the 64-char provider limit as a budget", () => {
    const long = "server_" + "x".repeat(100);
    const short = shortenToolName(long, MAX_TOOL_NAME_LENGTH, new Set());
    expect(short.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
  });
});
