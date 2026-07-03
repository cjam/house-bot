import { describe, expect, test } from "bun:test";
import { parseAllowlist, buildMcpServers, required } from "./config";

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

describe("required", () => {
  test("returns the value when present", () => {
    expect(required({ FOO: "bar" }, "FOO")).toBe("bar");
  });

  test("throws when missing", () => {
    expect(() => required({}, "FOO")).toThrow();
  });
});
