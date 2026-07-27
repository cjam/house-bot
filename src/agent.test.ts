import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import type { ModelMessage } from "ai";
import { ask } from "./agent";

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A model that always replies with the given text and no tool calls. */
function textModel(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: text ? [{ type: "text" as const, text }] : [],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  });
}

describe("ask", () => {
  test("appends the user prompt and returns the reply text", async () => {
    const result = await ask({
      messages: [],
      prompt: "hello",
      systemPrompt: "be helpful",
      model: textModel("hi there"),
      tools: {},
      maxSteps: 5,
    });

    expect(result.text).toBe("hi there");
    expect(result.messages[0]).toEqual({ role: "user", content: "hello" });
    expect(result.messages.at(-1)?.role).toBe("assistant");
  });

  test("threads prior history through, preserving order", async () => {
    const prior: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
    ];

    const result = await ask({
      messages: prior,
      prompt: "second",
      systemPrompt: "be helpful",
      model: textModel("ok"),
      tools: {},
      maxSteps: 5,
    });

    expect(result.messages[0]).toEqual({ role: "user", content: "first" });
    expect(result.messages[1]).toEqual({ role: "assistant", content: "reply" });
    expect(result.messages[2]).toEqual({ role: "user", content: "second" });
    expect(result.messages.at(-1)?.role).toBe("assistant");
  });

  test("falls back to a placeholder when the model returns no text", async () => {
    const result = await ask({
      messages: [],
      prompt: "hi",
      systemPrompt: "x",
      model: textModel(""),
      tools: {},
      maxSteps: 5,
    });

    expect(result.text).toBe("(no response)");
  });
});
