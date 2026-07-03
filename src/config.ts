import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

export type Env = Record<string, string | undefined>;

export function parseAllowlist(csv: string | undefined): Set<number> {
  if (!csv) return new Set();
  const ids = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number);
  return new Set(ids);
}

export function buildMcpServers(env: Env): Record<string, McpServerConfig> {
  const raw = env.MCP_SERVERS?.trim();
  if (!raw) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`MCP_SERVERS is not valid JSON: ${(err as Error).message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP_SERVERS must be a JSON object mapping server names to configs");
  }

  for (const [name, config] of Object.entries(parsed)) {
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new Error(`MCP_SERVERS["${name}"] must be an object`);
    }
  }

  return parsed as Record<string, McpServerConfig>;
}

export function required(env: Env, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export type Config = {
  telegramToken: string;
  allowedChatIds: Set<number>;
  mcpServers: Record<string, McpServerConfig>;
  model: string;
  sessionFile: string;
};

export function loadConfig(env: Env = process.env): Config {
  required(env, "ANTHROPIC_API_KEY");
  return {
    telegramToken: required(env, "TELEGRAM_TOKEN"),
    allowedChatIds: parseAllowlist(env.ALLOWED_CHAT_IDS),
    mcpServers: buildMcpServers(env),
    model: env.MODEL || "claude-opus-4-8",
    sessionFile: env.SESSION_FILE || "./data/sessions.json",
  };
}
