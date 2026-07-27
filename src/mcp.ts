import { createMCPClient, type MCPClient, type MCPTransport } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { ToolSet } from "ai";
import type { McpServerConfig } from "./config";
import { MAX_TOOL_NAME_LENGTH, shortenToolName } from "./tool-names";

export type McpTools = {
  /** Every configured server's tools, merged under unique, length-safe keys. */
  tools: ToolSet;
  /** Human-readable startup diagnostics, one line per entry. */
  describe(): string[];
  close(): Promise<void>;
};

type Transport = Parameters<typeof createMCPClient>[0]["transport"];

function transportFor(config: McpServerConfig): Transport {
  switch (config.type) {
    case "http":
    case "sse":
      return { type: config.type, url: config.url, headers: config.headers };
    default:
      // `type` is "stdio" or omitted: spawn a local process.
      return new Experimental_StdioMCPTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      }) as MCPTransport;
  }
}

/**
 * Connect to every configured MCP server through the AI SDK and merge their
 * tools into one `ToolSet`. Tool keys are namespaced per server (`<server>_<tool>`)
 * and shortened to fit the 64-char limit, staying unique across servers. A server
 * that fails to connect is logged and skipped, so the bot still starts (just
 * without that server's tools) rather than crashing.
 */
export async function createMcpTools(
  servers: Record<string, McpServerConfig>,
  log: (line: string) => void = () => {},
): Promise<McpTools> {
  const clients: MCPClient[] = [];
  const tools: ToolSet = {};
  const taken = new Set<string>();
  const lines: string[] = [];

  for (const [name, config] of Object.entries(servers)) {
    try {
      const client = await createMCPClient({ transport: transportFor(config) });
      const upstream = await client.tools();
      clients.push(client);

      const advertised: string[] = [];
      let shortened = 0;
      for (const [toolName, tool] of Object.entries(upstream)) {
        const original = `${name}_${toolName}`;
        const key = shortenToolName(original, MAX_TOOL_NAME_LENGTH, taken);
        if (key !== original) shortened++;
        tools[key] = tool;
        advertised.push(key);
      }

      const note =
        shortened > 0 ? ` (${shortened} shortened to fit the ${MAX_TOOL_NAME_LENGTH}-char limit)` : "";
      lines.push(`MCP server "${name}": connected, ${advertised.length} tools${note}`);
      lines.push(`  Resolved MCP tools: ${advertised.join(", ")}`);
    } catch (err) {
      log(`MCP server "${name}": failed to connect — ${err instanceof Error ? err.message : err}`);
    }
  }

  if (lines.length === 0) lines.push("No MCP tools resolved.");

  return {
    tools,
    describe: () => lines,
    async close() {
      await Promise.all(clients.map((client) => client.close().catch(() => {})));
    },
  };
}
