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

export type McpProbeResult = {
  tools: string[];
  servers: { name: string; status: string }[];
};

export type ProbeMcpOptions = {
  /** Give up waiting for servers to leave "pending" after this long. */
  timeoutMs?: number;
  /** How often to re-check server status while waiting. */
  pollIntervalMs?: number;
};

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_PROBE_POLL_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Probe configured MCP servers and report which tools they expose.
 *
 * The `system/init` message is emitted before Streamable-HTTP/SSE servers
 * finish their (asynchronous) connection handshake, so reading tools from it
 * races the connection and reports "pending" with zero tools. Instead we hold
 * the session open with a streaming input, drain its messages so control
 * responses get pumped, and poll `mcpServerStatus()` until every server has
 * settled out of "pending" (or we hit `timeoutMs`).
 */
export async function probeMcpServers(
  mcpServers: Record<string, McpServerConfig>,
  model: string,
  options: ProbeMcpOptions = {},
): Promise<McpProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_PROBE_POLL_MS;

  // An input stream that yields nothing keeps the session alive (no model turn
  // runs) until we resolve `closeInput`, at which point the subprocess exits.
  let closeInput!: () => void;
  const inputClosed = new Promise<void>((resolve) => {
    closeInput = resolve;
  });
  async function* heldOpenInput(): AsyncGenerator<never> {
    await inputClosed;
  }

  const q = query({
    prompt: heldOpenInput(),
    options: { mcpServers, model },
  });

  // Draining the response stream pumps the transport so control responses
  // (from mcpServerStatus) are actually read. We ignore the messages.
  const drain = (async () => {
    try {
      for await (const _msg of q) {
        void _msg;
      }
    } catch {
      // Stream teardown on close/interrupt is expected; ignore.
    }
  })();

  try {
    const deadline = Date.now() + timeoutMs;
    let statuses = await q.mcpServerStatus();
    while (statuses.some((s) => s.status === "pending") && Date.now() < deadline) {
      await delay(pollIntervalMs);
      statuses = await q.mcpServerStatus();
    }

    const tools = statuses.flatMap((server) =>
      (server.tools ?? []).map((t) => `mcp__${server.name}__${t.name}`),
    );
    const servers = statuses.map((server) => ({ name: server.name, status: server.status }));
    return { tools, servers };
  } finally {
    closeInput();
    try {
      await q.interrupt();
    } catch {
      // No active turn to interrupt when the probe never sent a prompt; ignore.
    }
    await drain;
  }
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
