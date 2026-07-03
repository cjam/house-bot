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

export type McpProbeResult = {
  tools: string[];
  servers: { name: string; status: string }[];
};

function isInitMessage(
  msg: SDKMessage,
): msg is Extract<SDKMessage, { type: "system"; subtype: "init" }> {
  return msg.type === "system" && msg.subtype === "init";
}

export async function probeMcpServers(
  mcpServers: Record<string, McpServerConfig>,
  model: string,
): Promise<McpProbeResult> {
  const q = query({
    prompt: "Reply with OK.",
    options: { mcpServers, model, maxTurns: 1 },
  });

  for await (const msg of q) {
    if (isInitMessage(msg)) {
      const tools: string[] = msg.tools.filter((toolName: string) => toolName.startsWith("mcp__"));
      return { tools, servers: msg.mcp_servers };
    }
  }

  throw new Error("Agent SDK did not emit an init message during MCP probe");
}

export function describeMcpProbe(
  result: McpProbeResult,
  configuredServers: Record<string, McpServerConfig>,
): string[] {
  const lines: string[] = [];

  if (result.tools.length === 0) {
    lines.push("No MCP tools resolved.");
  } else {
    lines.push(`Resolved MCP tools: ${result.tools.join(", ")}`);
  }

  for (const server of result.servers) {
    lines.push(`MCP server "${server.name}": ${server.status}`);
    if (server.status === "failed") {
      const config = configuredServers[server.name];
      if (config && config.type === "http") {
        lines.push(
          `  Hint: "${server.name}" is configured with type:"http" and failed to connect. If it doesn't speak Streamable HTTP, try type:"sse" instead.`,
        );
      }
    }
  }

  return lines;
}
