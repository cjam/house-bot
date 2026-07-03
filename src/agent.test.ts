import { describe, expect, test, mock } from "bun:test";
import type { SDKMessage, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { extractSessionId, appendAssistantText, describeMcpProbe } from "./agent";

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
    });

    expect(capturedOptions?.resume).toBe("previous-session");
    expect(result.sessionId).toBe("s1");
    expect(result.text).toBe("hi");
  });
});

describe("describeMcpProbe", () => {
  test("lists resolved mcp__* tools", () => {
    const lines = describeMcpProbe(
      { tools: ["mcp__mealie__get_recipe", "mcp__mealie__list_recipes"], servers: [{ name: "mealie", status: "connected" }] },
      {},
    );
    expect(lines.some((l) => l.includes("mcp__mealie__get_recipe"))).toBe(true);
  });

  test("notes when no tools resolved", () => {
    const lines = describeMcpProbe({ tools: [], servers: [] }, {});
    expect(lines.some((l) => l.toLowerCase().includes("no mcp tools"))).toBe(true);
  });

  test("hints at sse transport when an http server fails", () => {
    const configured: Record<string, McpServerConfig> = {
      mealie: { type: "http", url: "http://mealie.local" },
    };
    const lines = describeMcpProbe(
      { tools: [], servers: [{ name: "mealie", status: "failed" }] },
      configured,
    );
    expect(lines.some((l) => l.includes('type:"sse"') || l.includes("type: \"sse\""))).toBe(true);
  });

  test("does not hint sse for a server that is not type http", () => {
    const configured: Record<string, McpServerConfig> = {
      mealie: { type: "sse", url: "http://mealie.local" },
    };
    const lines = describeMcpProbe(
      { tools: [], servers: [{ name: "mealie", status: "failed" }] },
      configured,
    );
    expect(lines.some((l) => l.toLowerCase().includes("sse"))).toBe(false);
  });
});

describe("probeMcpServers", () => {
  test("returns mcp__* tools and server statuses from the init message", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: () => {
        return (async function* () {
          yield {
            type: "system",
            subtype: "init",
            tools: ["Read", "mcp__mealie__get_recipe"],
            mcp_servers: [{ name: "mealie", status: "connected" }],
          };
          yield { type: "assistant", message: { content: [{ type: "text", text: "OK" }] } };
        })();
      },
    }));

    const { probeMcpServers } = await import("./agent");
    const result = await probeMcpServers({}, "claude-opus-4-8");
    expect(result.tools).toEqual(["mcp__mealie__get_recipe"]);
    expect(result.servers).toEqual([{ name: "mealie", status: "connected" }]);
  });
});
