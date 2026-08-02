import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import type { ToolSet } from "ai";
import type { AskParams, AskResult } from "./agent";
import { createRecipeTool } from "./recipe-tool";
import { recipeAgent } from "./agents";

const MODEL = new MockLanguageModelV4();

const call = (tools: ToolSet, args: unknown) =>
  (tools.find_or_create_recipe!.execute as (a: unknown, o: unknown) => Promise<any>)(args, {
    toolCallId: "t",
    messages: [],
  });

/** A recipe tool whose nested `ask` is stubbed to record how it was invoked. */
function setup() {
  const calls: AskParams[] = [];
  const ask = async (params: AskParams): Promise<AskResult> => {
    calls.push(params);
    return { messages: [], text: "Found existing recipe 'Egg Roll in a Bowl' (slug: egg-roll-in-a-bowl)." };
  };
  const tools = createRecipeTool({
    ask,
    modelFor: () => MODEL,
    tools: { mealie_get_all_api_recipes_get: {} as any },
    agent: recipeAgent,
  });
  return { calls, tools };
}

describe("find_or_create_recipe", () => {
  test("runs a nested turn with the recipe agent's prompt and tools, isolated from the caller", async () => {
    const { calls, tools } = setup();
    const res = await call(tools, { name: "egg roll in a bowl" });

    expect(res.result).toContain("Egg Roll in a Bowl");
    expect(calls.length).toBe(1);
    // Fresh context (no inherited history) and the recipe persona/tools.
    expect(calls[0]!.messages).toEqual([]);
    expect(calls[0]!.systemPrompt).toBe(recipeAgent.systemPrompt);
    expect(Object.keys(calls[0]!.tools)).toContain("mealie_get_all_api_recipes_get");
    expect(calls[0]!.prompt).toContain("egg roll in a bowl");
  });

  test("threads an import URL and notes into the sub-agent prompt", async () => {
    const { calls, tools } = setup();
    await call(tools, { name: "Salmon Burgers", importUrl: "https://example.com/r", notes: "use dill" });
    expect(calls[0]!.prompt).toContain("https://example.com/r");
    expect(calls[0]!.prompt).toContain("use dill");
  });
});
