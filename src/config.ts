export type Env = Record<string, string | undefined>;

/**
 * A configured MCP server. Previously imported from the Claude Agent SDK; now
 * defined here since we speak MCP through the Vercel AI SDK's `@ai-sdk/mcp`.
 * `http`/`sse` connect to a remote URL; the default (`stdio`) spawns a process.
 */
export type McpServerConfig =
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> }
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

/** Providers the model-resolution seam knows about. Only `openrouter` is wired. */
export type Provider = "openrouter" | "anthropic" | "openai" | "google";

/**
 * Per-provider config lives under that provider's own namespace, so each can
 * carry independent settings (and future extras) without colliding: the active
 * provider is picked by `PROVIDER`, then only its `<PROVIDER>_*` vars are read.
 */
type ProviderSpec = { keyEnv: string; modelEnv: string; defaultModel: string };

const PROVIDERS: Record<Provider, ProviderSpec> = {
  openrouter: {
    keyEnv: "OPENROUTER_API_KEY",
    modelEnv: "OPENROUTER_MODEL",
    // Cost-efficient default with reliable tool calling; bump to
    // anthropic/claude-sonnet-4.5 for harder tasks.
    defaultModel: "google/gemini-2.5-flash",
  },
  anthropic: {
    keyEnv: "ANTHROPIC_API_KEY",
    modelEnv: "ANTHROPIC_MODEL",
    defaultModel: "claude-sonnet-4-5",
  },
  openai: {
    keyEnv: "OPENAI_API_KEY",
    modelEnv: "OPENAI_MODEL",
    defaultModel: "gpt-5-mini",
  },
  google: {
    keyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
    modelEnv: "GOOGLE_MODEL",
    defaultModel: "gemini-2.5-flash",
  },
};

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

function parseProvider(env: Env): Provider {
  const value = (env.PROVIDER || "openrouter").toLowerCase();
  if (value in PROVIDERS) return value as Provider;
  throw new Error(`PROVIDER must be one of ${Object.keys(PROVIDERS).join(", ")} (got "${value}")`);
}

// The base persona/instructions live in their own module (committed, so they
// ship via CI); SYSTEM_PROMPT still overrides. Re-exported here for callers/tests.
export { DEFAULT_SYSTEM_PROMPT } from "./system-prompt";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt";

export type Config = {
  telegramToken: string;
  allowedChatIds: Set<number>;
  mcpServers: Record<string, McpServerConfig>;
  /** Base persona/instructions for the agent (from SYSTEM_PROMPT, or the default). */
  systemPrompt: string;
  /** Which provider the model runs on. */
  provider: Provider;
  /** API key for the selected provider. */
  apiKey: string;
  /** Model id, in the selected provider's namespace (e.g. an OpenRouter slug). */
  model: string;
  /** Max steps in the agentic tool loop before the run stops. */
  maxSteps: number;
  /** Default number of days to plan meals for (overridable per chat). */
  planDays: number;
  /** Enable the provider's web-search tool (OpenRouter only for now). */
  webSearch: boolean;
  sessionFile: string;
  /** How long a chat can sit idle before its next message starts a fresh session. */
  sessionIdleMs: number;
  /** Where scheduled prompts are persisted. */
  scheduleFile: string;
  /** Where per-chat settings overrides are persisted. */
  settingsFile: string;
  /** Where the last-announced release version is persisted (for deploy notes). */
  deployStateFile: string;
  /** Process timezone (from TZ), stamped on new schedules and used for display. */
  timezone?: string;
  /** Default coordinates for the weather tool (the household's home). */
  homeLat: number;
  homeLong: number;
  /** Directory for per-chat JSONL transcript logs; undefined disables logging. */
  transcriptDir?: string;
};

export function loadConfig(env: Env = process.env): Config {
  const provider = parseProvider(env);
  const spec = PROVIDERS[provider];
  return {
    telegramToken: required(env, "TELEGRAM_TOKEN"),
    allowedChatIds: parseAllowlist(env.ALLOWED_CHAT_IDS),
    mcpServers: buildMcpServers(env),
    systemPrompt: env.SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT,
    provider,
    apiKey: required(env, spec.keyEnv),
    model: env[spec.modelEnv] || spec.defaultModel,
    maxSteps: Number(env.MAX_STEPS || 20),
    planDays: Number(env.PLAN_DAYS || 5),
    webSearch: env.WEB_SEARCH === "true",
    sessionFile: env.SESSION_FILE || "./data/sessions.json",
    sessionIdleMs: Number(env.SESSION_IDLE_MINUTES || 15) * 60_000,
    scheduleFile: env.SCHEDULE_FILE || "./data/schedules.json",
    settingsFile: env.SETTINGS_FILE || "./data/settings.json",
    deployStateFile: env.DEPLOY_STATE_FILE || "./data/deploy.json",
    timezone: env.TZ?.trim() || undefined,
    // Default to Victoria, B.C.; the weather tool also accepts per-call coords.
    homeLat: Number(env.HOME_LAT || 48.496),
    homeLong: Number(env.HOME_LONG || -123.393),
    transcriptDir: env.TRANSCRIPT_DIR?.trim() || undefined,
  };
}
