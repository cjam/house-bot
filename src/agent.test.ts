import { describe, expect, test, mock } from "bun:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { extractSessionId, appendAssistantText } from "./agent";

function assistantMsg(content: Array<{ type: string; text?: string }>): SDKMessage {
  return {
    type: "assistant",
    message: { content },
    parent_tool_use_id: null,
    uuid: "u1",
    session_id: "s1",
  } as unknown as SDKMessage;
}

function initMsg(sessionId: string): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
  } as unknown as SDKMessage;
}

describe("extractSessionId", () => {
  test("returns session_id from a system/init message", () => {
    expect(extractSessionId(initMsg("abc-123"))).toBe("abc-123");
  });

  test("returns undefined for non-init messages", () => {
    expect(extractSessionId(assistantMsg([{ type: "text", text: "hi" }]))).toBeUndefined();
  });
});

describe("appendAssistantText", () => {
  test("concatenates text blocks from an assistant message", () => {
    const msg = assistantMsg([
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ]);
    expect(appendAssistantText("", msg)).toBe("hello world");
  });

  test("ignores tool_use blocks", () => {
    const msg = assistantMsg([
      { type: "tool_use", text: undefined },
      { type: "text", text: "answer" },
    ]);
    expect(appendAssistantText("", msg)).toBe("answer");
  });

  test("appends to existing accumulator", () => {
    const msg = assistantMsg([{ type: "text", text: " more" }]);
    expect(appendAssistantText("start", msg)).toBe("start more");
  });

  test("non-assistant messages leave the accumulator unchanged", () => {
    expect(appendAssistantText("unchanged", initMsg("s1"))).toBe("unchanged");
  });
});

describe("ask", () => {
  test("resumes with the saved session id and persists the returned one", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: (params: { prompt: string; options?: Record<string, unknown> }) => {
        capturedOptions = params.options;
        return (async function* () {
          yield { type: "system", subtype: "init", session_id: "s1" };
          yield {
            type: "assistant",
            message: { content: [{ type: "text", text: "hi" }] },
          };
        })();
      },
    }));

    const { ask } = await import("./agent");

    const result = await ask({
      prompt: "hello",
      resume: "previous-session",
      systemPrompt: "be helpful",
      model: "claude-opus-4-8",
      mcpServers: {},
      canUseTool: async () => ({ behavior: "deny", message: "no" }),
      builtinTools: ["WebSearch"],
    });

    expect(capturedOptions?.resume).toBe("previous-session");
    expect(capturedOptions?.tools).toEqual(["WebSearch"]);
    expect(result.sessionId).toBe("s1");
    expect(result.text).toBe("hi");
  });
});
