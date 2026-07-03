import { query, type CanUseTool, type McpServerConfig, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export function extractSessionId(msg: SDKMessage): string | undefined {
  if (msg.type === "system" && msg.subtype === "init") {
    return msg.session_id;
  }
  return undefined;
}

export function appendAssistantText(acc: string, msg: SDKMessage): string {
  if (msg.type !== "assistant") return acc;
  const content = msg.message.content as Array<{ type: string; text?: string }>;
  const text = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  return acc + text;
}

export type AskParams = {
  prompt: string;
  resume?: string;
  systemPrompt: string;
  model: string;
  mcpServers: Record<string, McpServerConfig>;
  canUseTool: CanUseTool;
  /**
   * Built-in (non-MCP) tools to load into the prompt. Keep this to the tools
   * the permission gate actually allows — loading the full Claude Code tool set
   * wastes input tokens on schemas we always deny.
   */
  builtinTools: string[];
};

export type AskResult = {
  sessionId: string;
  text: string;
};

export async function ask(params: AskParams): Promise<AskResult> {
  let sessionId: string | undefined;
  let text = "";

  for await (const msg of query({
    prompt: params.prompt,
    options: {
      resume: params.resume,
      systemPrompt: params.systemPrompt,
      model: params.model,
      mcpServers: params.mcpServers,
      canUseTool: params.canUseTool,
      tools: params.builtinTools,
    },
  })) {
    sessionId = extractSessionId(msg) ?? sessionId;
    text = appendAssistantText(text, msg);
  }

  if (!sessionId) {
    throw new Error("Agent SDK did not return a session id");
  }

  return { sessionId, text: text || "(no response)" };
}
