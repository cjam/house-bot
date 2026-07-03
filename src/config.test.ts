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
  test("includes mealie only when MEALIE_URL is set", () => {
    const servers = buildMcpServers({});
    expect(servers.mealie).toBeUndefined();
  });

  test("mealie present with Authorization header when token set", () => {
    const servers = buildMcpServers({
      MEALIE_URL: "http://mealie.local/api/mcp",
      MEALIE_TOKEN: "secret-token",
    });
    expect(servers.mealie).toEqual({
      type: "http",
      url: "http://mealie.local/api/mcp",
      headers: { Authorization: "Bearer secret-token" },
    });
  });

  test("Authorization header omitted when no token set", () => {
    const servers = buildMcpServers({ MEALIE_URL: "http://mealie.local/api/mcp" });
    expect(servers.mealie).toEqual({
      type: "http",
      url: "http://mealie.local/api/mcp",
      headers: {},
    });
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
