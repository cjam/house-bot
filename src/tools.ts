import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

// The only built-in (non-MCP) tools this bot exposes. Used both to gate
// execution (below) and to restrict which built-in tool schemas the Agent SDK
// loads into the prompt — loading the full Claude Code tool set would waste
// thousands of input tokens per turn on tools we always deny.
export const ALLOWED_BUILTIN_TOOLS = ["WebSearch"] as const;

const ALWAYS_ALLOWED = new Set<string>(ALLOWED_BUILTIN_TOOLS);

export const canUseTool: CanUseTool = async (toolName, input) => {
  if (toolName.startsWith("mcp__") || ALWAYS_ALLOWED.has(toolName)) {
    return { behavior: "allow", updatedInput: input };
  }
  return {
    behavior: "deny",
    message: `Tool "${toolName}" is not permitted. Only MCP tools and WebSearch are allowed.`,
  };
};
