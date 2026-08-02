import { describe, expect, test } from "bun:test";
import {
  parseAllowlist,
  buildMcpServers,
  required,
  loadConfig,
  DEFAULT_SYSTEM_PROMPT,
} from "./config";

const BASE_ENV = { OPENROUTER_API_KEY: "sk-test", TELEGRAM_TOKEN: "bot-token" };

describe("parseAllowlist", () => {
  test("trims whitespace and drops empty entries", () => {
    expect(parseAllowlist(" 123 , 456,, 789 ")).toEqual(new Set([123, 456, 789]));
  });

  test("empty csv produces an empty set", () => {
    expect(parseAllowlist("")).toEqual(new Set());
  });

  test("undefined produces an empty set", () => {
    expect(parseAllowlist(undefined)).toEqual(new Set());
  });
});

describe("buildMcpServers", () => {
  test("returns an empty object when MCP_SERVERS is unset", () => {
    expect(buildMcpServers({})).toEqual({});
  });

  test("returns an empty object when MCP_SERVERS is blank", () => {
    expect(buildMcpServers({ MCP_SERVERS: "   " })).toEqual({});
  });

  test("parses a single server from JSON", () => {
    const servers = buildMcpServers({
      MCP_SERVERS: JSON.stringify({
        mealie: {
          type: "http",
          url: "http://mealie.local/api/mcp",
          headers: { Authorization: "Bearer secret-token" },
        },
      }),
    });
    expect(servers.mealie).toEqual({
      type: "http",
      url: "http://mealie.local/api/mcp",
      headers: { Authorization: "Bearer secret-token" },
    });
  });

  test("parses multiple servers of different transports", () => {
    const servers = buildMcpServers({
      MCP_SERVERS: JSON.stringify({
        mealie: { type: "http", url: "http://mealie.local/api/mcp" },
        homebox: { type: "sse", url: "http://homebox.local/mcp" },
      }),
    });
    expect(Object.keys(servers).sort()).toEqual(["homebox", "mealie"]);
    expect(servers.homebox).toEqual({ type: "sse", url: "http://homebox.local/mcp" });
  });

  test("throws on invalid JSON", () => {
    expect(() => buildMcpServers({ MCP_SERVERS: "{not json" })).toThrow(/MCP_SERVERS/);
  });

  test("throws when the JSON is not an object", () => {
    expect(() => buildMcpServers({ MCP_SERVERS: "[]" })).toThrow(/MCP_SERVERS/);
    expect(() => buildMcpServers({ MCP_SERVERS: '"a string"' })).toThrow(/MCP_SERVERS/);
  });

  test("throws when a server entry is not an object", () => {
    expect(() =>
      buildMcpServers({ MCP_SERVERS: JSON.stringify({ mealie: "http://x" }) }),
    ).toThrow(/mealie/);
  });
});

describe("loadConfig", () => {
  test("defaults sessionIdleMs to 15 minutes", () => {
    expect(loadConfig(BASE_ENV).sessionIdleMs).toBe(15 * 60_000);
  });

  test("SESSION_IDLE_MINUTES overrides the default", () => {
    expect(loadConfig({ ...BASE_ENV, SESSION_IDLE_MINUTES: "30" }).sessionIdleMs).toBe(30 * 60_000);
  });

  test("defaults to the OpenRouter provider and reads its key", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.provider).toBe("openrouter");
    expect(config.apiKey).toBe("sk-test");
  });

  test("defaults model to the cost-efficient OpenRouter slug", () => {
    expect(loadConfig(BASE_ENV).model).toBe("google/gemini-2.5-flash");
  });

  test("OPENROUTER_MODEL overrides the OpenRouter default", () => {
    expect(loadConfig({ ...BASE_ENV, OPENROUTER_MODEL: "openai/gpt-4o" }).model).toBe("openai/gpt-4o");
  });

  test("reads each provider's own namespaced key and model", () => {
    const config = loadConfig({
      TELEGRAM_TOKEN: "t",
      PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_MODEL: "claude-opus-4-8",
      // The OpenRouter vars must be ignored when anthropic is active.
      OPENROUTER_API_KEY: "sk-or",
      OPENROUTER_MODEL: "google/gemini-2.5-flash",
    });
    expect(config.apiKey).toBe("sk-ant");
    expect(config.model).toBe("claude-opus-4-8");
  });

  test("defaults systemPrompt to DEFAULT_SYSTEM_PROMPT", () => {
    expect(loadConfig(BASE_ENV).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("SYSTEM_PROMPT overrides the default base prompt", () => {
    const config = loadConfig({ ...BASE_ENV, SYSTEM_PROMPT: "  You are a garden assistant.  " });
    expect(config.systemPrompt).toBe("You are a garden assistant.");
  });

  test("blank SYSTEM_PROMPT falls back to the default", () => {
    expect(loadConfig({ ...BASE_ENV, SYSTEM_PROMPT: "   " }).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test("defaults maxSteps to 12 and webSearch off", () => {
    const config = loadConfig(BASE_ENV);
    expect(config.maxSteps).toBe(12);
    expect(config.webSearch).toBe(false);
  });

  test("defaults planDays to 5 and honors PLAN_DAYS", () => {
    expect(loadConfig(BASE_ENV).planDays).toBe(5);
    expect(loadConfig({ ...BASE_ENV, PLAN_DAYS: "7" }).planDays).toBe(7);
  });

  test("defaults deployStateFile and honors DEPLOY_STATE_FILE", () => {
    expect(loadConfig(BASE_ENV).deployStateFile).toBe("./data/deploy.json");
    expect(loadConfig({ ...BASE_ENV, DEPLOY_STATE_FILE: "/tmp/d.json" }).deployStateFile).toBe("/tmp/d.json");
  });

  test("MAX_STEPS and WEB_SEARCH override the defaults", () => {
    const config = loadConfig({ ...BASE_ENV, MAX_STEPS: "5", WEB_SEARCH: "true" });
    expect(config.maxSteps).toBe(5);
    expect(config.webSearch).toBe(true);
  });

  test("requires the selected provider's key", () => {
    // PROVIDER=anthropic needs ANTHROPIC_API_KEY, not OPENROUTER_API_KEY.
    expect(() => loadConfig({ ...BASE_ENV, PROVIDER: "anthropic" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(
      loadConfig({ TELEGRAM_TOKEN: "t", PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }).provider,
    ).toBe("anthropic");
  });

  test("rejects an unknown provider", () => {
    expect(() => loadConfig({ ...BASE_ENV, PROVIDER: "bogus" })).toThrow(/PROVIDER/);
  });
});

describe("required", () => {
  test("returns the value when present", () => {
    expect(required({ FOO: "bar" }, "FOO")).toBe("bar");
  });

  test("throws when missing", () => {
    expect(() => required({}, "FOO")).toThrow();
  });
});
