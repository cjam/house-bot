import { describe, expect, test } from "bun:test";
import { canUseTool } from "./tools";

const baseOptions = {
  signal: new AbortController().signal,
  toolUseID: "tool-use-1",
  requestId: "req-1",
};

describe("canUseTool", () => {
  test("allows mcp__* tools and returns updatedInput unchanged", async () => {
    const input = { url: "https://example.com" };
    const result = await canUseTool("mcp__mealie__get_recipe", input, baseOptions);
    expect(result).not.toBeNull();
    expect(result?.behavior).toBe("allow");
    if (result?.behavior === "allow") {
      expect(result.updatedInput).toBe(input);
    }
  });

  test("allows WebSearch", async () => {
    const input = { query: "weather today" };
    const result = await canUseTool("WebSearch", input, baseOptions);
    expect(result?.behavior).toBe("allow");
    if (result?.behavior === "allow") {
      expect(result.updatedInput).toBe(input);
    }
  });

  test("denies Bash with a message", async () => {
    const result = await canUseTool("Bash", { command: "ls" }, baseOptions);
    expect(result?.behavior).toBe("deny");
    if (result?.behavior === "deny") {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  test("denies Read with a message", async () => {
    const result = await canUseTool("Read", { file_path: "/etc/passwd" }, baseOptions);
    expect(result?.behavior).toBe("deny");
    if (result?.behavior === "deny") {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  test("denies arbitrary unknown tool names", async () => {
    const result = await canUseTool("SomeOtherTool", {}, baseOptions);
    expect(result?.behavior).toBe("deny");
  });
});
