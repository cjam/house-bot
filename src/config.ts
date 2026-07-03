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
  const servers: Record<string, McpServerConfig> = {};

  if (env.MEALIE_URL) {
    servers.mealie = {
      type: "http",
      url: env.MEALIE_URL,
      headers: env.MEALIE_TOKEN ? { Authorization: `Bearer ${env.MEALIE_TOKEN}` } : {},
    };
  }

  return servers;
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
