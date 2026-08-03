import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import type { ToolSet } from "ai";
import type { AskParams, AskResult } from "./agent";
import { createLibrarianTool } from "./librarian-tool";
import { librarianAgent } from "./agents";

const MODEL = new MockLanguageModelV4();

const call = (tools: ToolSet, args: unknown) =>
  (tools.tidy_recipe_library!.execute as (a: unknown, o: unknown) => Promise<any>)(args, {
    toolCallId: "t",
    messages: [],
  });

/** A librarian tool whose nested `ask` is stubbed to record how it was invoked. */
function setup() {
  const calls: AskParams[] = [];
  const ask = async (params: AskParams): Promise<AskResult> => {
    calls.push(params);
    return { messages: [], text: "Cleaned up 3 recipes and fixed 5 ingredients." };
  };
  const tools = createLibrarianTool({
    ask,
    modelFor: () => MODEL,
    tools: { mealie_get_recipes_needing_cleanup: {} as any, mealie_cleanup_recipe: {} as any },
    agent: librarianAgent,
  });
  return { calls, tools };
}

describe("tidy_recipe_library", () => {
  test("runs a nested turn with the librarian's prompt and tools, isolated from the caller", async () => {
    const { calls, tools } = setup();
    const res = await call(tools, { task: "clean up recipes that need it" });

    expect(res.result).toContain("Cleaned up 3 recipes");
    expect(calls.length).toBe(1);
    expect(calls[0]!.messages).toEqual([]); // fresh context
    expect(calls[0]!.systemPrompt).toBe(librarianAgent.systemPrompt);
    expect(Object.keys(calls[0]!.tools)).toContain("mealie_get_recipes_needing_cleanup");
    expect(calls[0]!.prompt).toContain("clean up recipes");
  });

  test("gives the librarian more steps than a single recipe find/create", async () => {
    const { calls, tools } = setup();
    await call(tools, { task: "tidy the whole library" });
    expect(calls[0]!.maxSteps).toBeGreaterThan(8);
  });
});
