import type { McpServerConfig, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// The Anthropic Messages API rejects any tool whose name is longer than 64
// characters (it must match ^[a-zA-Z0-9_-]{1,64}$). The name the model sees for
// an MCP tool is `mcp__<server>__<tool>`, so servers like Mealie — whose tools
// are auto-named from long FastAPI operation IDs — routinely exceed the limit
// and get the whole request rejected. This module fronts each upstream MCP
// server with an in-process proxy that re-exposes every tool under a name that
// fits in 64 characters, forwarding calls back to the real server.

export const MAX_TOOL_NAME_LENGTH = 64;
const HASH_LENGTH = 6;

/** djb2 string hash, rendered in base36 — short, portable, deterministic. */
function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Characters available for the bare tool name after the SDK's
 * `mcp__<server>__` prefix, so that the full advertised name fits in 64 chars.
 */
export function bareNameBudget(serverName: string): number {
  return MAX_TOOL_NAME_LENGTH - `mcp__${serverName}__`.length;
}

/**
 * Return a tool name that fits within `budget` characters and is unique among
 * `taken`. Names that already fit pass through unchanged; longer ones are
 * truncated and suffixed with a short deterministic hash of the *original*
 * name, so two different originals never collapse to the same short name.
 * `taken` is mutated to record the returned name.
 */
export function shortenToolName(original: string, budget: number, taken: Set<string>): string {
  if (original.length <= budget && !taken.has(original)) {
    taken.add(original);
    return original;
  }

  const hash = djb2(original).slice(0, HASH_LENGTH);
  const truncate = (extra: number) =>
    `${original.slice(0, Math.max(1, budget - hash.length - 1 - extra))}_${hash}${
      extra > 0 ? (extra - 1).toString(36) : ""
    }`;

  let name = truncate(0);
  // Truncation collisions are extremely unlikely given the per-original hash,
  // but disambiguate deterministically if one occurs anyway.
  for (let salt = 1; taken.has(name); salt++) {
    name = truncate(salt);
  }
  taken.add(name);
  return name;
}

export type ToolNameMap = {
  /** Tools re-named to fit the length limit, in upstream order. */
  proxyTools: Tool[];
  /** short (advertised) name -> original upstream name. */
  shortToOriginal: Map<string, string>;
  /** Original names that had to be shortened (for diagnostics). */
  shortened: string[];
};

/** Build the shortened-name view of an upstream server's tools. */
export function buildToolNameMap(tools: Tool[], serverName: string): ToolNameMap {
  const budget = bareNameBudget(serverName);
  const taken = new Set<string>();
  const shortToOriginal = new Map<string, string>();
  const shortened: string[] = [];

  const proxyTools = tools.map((tool) => {
    const short = shortenToolName(tool.name, budget, taken);
    shortToOriginal.set(short, tool.name);
    if (short !== tool.name) shortened.push(tool.name);
    return { ...tool, name: short };
  });

  return { proxyTools, shortToOriginal, shortened };
}

function makeClientTransport(config: McpServerConfig): Transport {
  switch (config.type) {
    case "http":
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    case "sse":
      return new SSEClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });
    case "sdk":
      throw new Error("SDK MCP servers are already in-process and do not need proxying");
    default:
      // `type` is "stdio" or omitted.
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });
  }
}

export type McpProxyLogger = (line: string) => void;

/**
 * A single upstream MCP server fronted by name-shortening proxies. Owns one
 * persistent upstream connection; hands out a fresh in-process proxy `Server`
 * per agent turn (each agent query connects its own transport, so instances
 * must not be shared across concurrent turns).
 */
export class McpProxy {
  readonly serverName: string;
  private readonly newTransport: () => Transport;
  private readonly client: Client;
  private nameMap: ToolNameMap = { proxyTools: [], shortToOriginal: new Map(), shortened: [] };
  private connected = false;

  constructor(serverName: string, config: McpServerConfig, transportFactory?: () => Transport) {
    this.serverName = serverName;
    this.newTransport = transportFactory ?? (() => makeClientTransport(config));
    this.client = new Client(
      { name: `house-bot-proxy-${serverName}`, version: "1.0.0" },
      { capabilities: {} },
    );
    this.client.onclose = () => {
      this.connected = false;
    };
  }

  /** Connect upstream and load its tool list. */
  async connect(): Promise<void> {
    await this.client.connect(this.newTransport());
    this.connected = true;
    this.nameMap = buildToolNameMap(await this.listUpstreamTools(), this.serverName);
  }

  private async listUpstreamTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    // Reconnect after an upstream drop (e.g. the server restarted). Reuse the
    // existing name map so short names stay stable across the reconnect.
    await this.client.connect(this.newTransport());
    this.connected = true;
  }

  private async callUpstream(shortName: string, args: Record<string, unknown>) {
    const original = this.nameMap.shortToOriginal.get(shortName) ?? shortName;
    await this.ensureConnected();
    return this.client.callTool({ name: original, arguments: args });
  }

  /** Names (already prefixed) the model will see for this server's tools. */
  get advertisedToolNames(): string[] {
    return this.nameMap.proxyTools.map((tool) => `mcp__${this.serverName}__${tool.name}`);
  }

  get shortenedCount(): number {
    return this.nameMap.shortened.length;
  }

  /**
   * Build a fresh proxy server config for one agent turn. The returned
   * instance forwards `tools/list` and `tools/call` to the shared upstream
   * connection under the original tool names.
   */
  toServerConfig(): McpSdkServerConfigWithInstance {
    const instance = new Server(
      { name: this.serverName, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    instance.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.nameMap.proxyTools,
    }));
    instance.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.callUpstream(request.params.name, request.params.arguments ?? {}),
    );
    // The type wants a high-level McpServer; the SDK only ever calls
    // `.connect(transport)` on it, which the low-level Server also provides.
    return { type: "sdk", name: this.serverName, instance: instance as never };
  }

  async close(): Promise<void> {
    this.connected = false;
    await this.client.close().catch(() => {});
  }
}

export type McpProxies = {
  /** Fresh proxy server configs (one instance set per agent turn). */
  buildServers(): Record<string, McpSdkServerConfigWithInstance>;
  /** Human-readable startup diagnostics, one line per entry. */
  describe(): string[];
  close(): Promise<void>;
};

/**
 * Connect a name-shortening proxy in front of every configured MCP server.
 * Failures to reach a server are logged and that server is skipped, so the bot
 * still starts (just without that server's tools) rather than crashing.
 */
export async function createMcpProxies(
  mcpServers: Record<string, McpServerConfig>,
  log: McpProxyLogger = () => {},
): Promise<McpProxies> {
  const proxies: McpProxy[] = [];

  for (const [name, config] of Object.entries(mcpServers)) {
    const proxy = new McpProxy(name, config);
    try {
      await proxy.connect();
      proxies.push(proxy);
    } catch (err) {
      log(`MCP server "${name}": failed to connect — ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    buildServers() {
      const servers: Record<string, McpSdkServerConfigWithInstance> = {};
      for (const proxy of proxies) {
        servers[proxy.serverName] = proxy.toServerConfig();
      }
      return servers;
    },
    describe() {
      if (proxies.length === 0) return ["No MCP tools resolved."];
      const lines: string[] = [];
      for (const proxy of proxies) {
        const names = proxy.advertisedToolNames;
        const shortenedNote = proxy.shortenedCount > 0 ? ` (${proxy.shortenedCount} shortened to fit the 64-char limit)` : "";
        lines.push(`MCP server "${proxy.serverName}": connected, ${names.length} tools${shortenedNote}`);
        lines.push(`  Resolved MCP tools: ${names.join(", ")}`);
      }
      return lines;
    },
    async close() {
      await Promise.all(proxies.map((proxy) => proxy.close()));
    },
  };
}
