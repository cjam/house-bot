import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

const ALWAYS_ALLOWED = new Set(["WebSearch"]);

export const canUseTool: CanUseTool = async (toolName, input) => {
  if (toolName.startsWith("mcp__") || ALWAYS_ALLOWED.has(toolName)) {
    return { behavior: "allow", updatedInput: input };
  }
  return {
    behavior: "deny",
    message: `Tool "${toolName}" is not permitted. Only MCP tools and WebSearch are allowed.`,
  };
};
