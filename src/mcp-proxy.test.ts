import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_TOOL_NAME_LENGTH,
  bareNameBudget,
  shortenToolName,
  buildToolNameMap,
  McpProxy,
} from "./mcp-proxy";

describe("bareNameBudget", () => {
  test("accounts for the mcp__<server>__ prefix", () => {
    expect(bareNameBudget("mealie")).toBe(64 - "mcp__mealie__".length);
    expect(bareNameBudget("m")).toBe(64 - "mcp__m__".length);
  });
});

describe("shortenToolName", () => {
  test("passes short names through unchanged", () => {
    const taken = new Set<string>();
    expect(shortenToolName("get_all_recipes", 51, taken)).toBe("get_all_recipes");
    expect(taken.has("get_all_recipes")).toBe(true);
  });

  test("shortens over-budget names to fit the budget", () => {
    const long = "add_single_recipe_ingredients_to_list_api_households_shopping";
    const short = shortenToolName(long, 51, new Set());
    expect(short.length).toBeLessThanOrEqual(51);
    // keeps a readable prefix of the original
    expect(short.startsWith("add_single_recipe")).toBe(true);
  });

  test("distinct originals never collide, even sharing a prefix", () => {
    const budget = 51;
    const taken = new Set<string>();
    const a = "create_many_api_households_shopping_items_create_bulk_post_a";
    const b = "create_many_api_households_shopping_items_create_bulk_post_b";
    const sa = shortenToolName(a, budget, taken);
    const sb = shortenToolName(b, budget, taken);
    expect(sa).not.toBe(sb);
    expect(sa.length).toBeLessThanOrEqual(budget);
    expect(sb.length).toBeLessThanOrEqual(budget);
  });

  test("disambiguates a duplicate short name that is already taken", () => {
    const taken = new Set<string>(["get_all_recipes"]);
    const short = shortenToolName("get_all_recipes", 51, taken);
    expect(short).not.toBe("get_all_recipes");
    expect(short.length).toBeLessThanOrEqual(51);
  });
});

describe("buildToolNameMap", () => {
  const tools: Tool[] = [
    { name: "get_all_recipes", description: "list", inputSchema: { type: "object" } },
    {
      name: "add_single_recipe_ingredients_to_list_api_households_shopping",
      description: "long A",
      inputSchema: { type: "object" },
    },
    {
      name: "create_many_api_households_shopping_items_create_bulk_post_x",
      description: "long B",
      inputSchema: { type: "object" },
    },
  ];

  test("every advertised name fits the 64-char limit", () => {
    const { proxyTools } = buildToolNameMap(tools, "mealie");
    for (const tool of proxyTools) {
      expect(`mcp__mealie__${tool.name}`.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    }
  });

  test("preserves order, descriptions, and schemas; maps short back to original", () => {
    const { proxyTools, shortToOriginal, shortened } = buildToolNameMap(tools, "mealie");
    expect(proxyTools.length).toBe(3);
    expect(proxyTools[0]!.name).toBe("get_all_recipes"); // short enough, unchanged
    expect(proxyTools[1]!.description).toBe("long A");
    expect(proxyTools[1]!.inputSchema).toEqual({ type: "object" });
    // the two long names were shortened
    expect(shortened).toContain(tools[1]!.name);
    expect(shortened).toContain(tools[2]!.name);
    // round-trips
    for (const tool of proxyTools) {
      expect(shortToOriginal.get(tool.name)).toBeDefined();
    }
    expect(shortToOriginal.get(proxyTools[1]!.name)).toBe(tools[1]!.name);
  });
});

/** A real upstream MCP server, reachable over an in-memory transport. */
function makeUpstream() {
  const server = new McpServer({ name: "mealie", version: "1.0.0" });
  server.tool("get_all_recipes", "List recipes", {}, async () => ({
    content: [{ type: "text", text: "recipes-ok" }],
  }));
  server.tool(
    "add_single_recipe_ingredients_to_list_api_households_shopping",
    "long name",
    { id: z.string() },
    async (args: { id: string }) => ({ content: [{ type: "text", text: `added-${args.id}` }] }),
  );
  return server;
}

describe("McpProxy (integration over in-memory transport)", () => {
  test("connects, advertises fitting names, and forwards calls to the upstream original", async () => {
    const upstream = makeUpstream();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await upstream.connect(serverSide);

    const proxy = new McpProxy("mealie", { type: "http", url: "http://unused" }, () => clientSide);
    await proxy.connect();

    // All advertised names fit the limit.
    const advertised = proxy.advertisedToolNames;
    expect(advertised.length).toBe(2);
    for (const name of advertised) expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    expect(proxy.shortenedCount).toBe(1);

    // Drive the proxy the way the agent SDK does: connect a client to the
    // proxy instance and call tools by their advertised (short) names.
    const config = proxy.toServerConfig();
    const [toClient, toServer] = InMemoryTransport.createLinkedPair();
    await (config.instance as unknown as { connect: (t: unknown) => Promise<void> }).connect(toServer);
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const model = new Client({ name: "model", version: "1.0.0" }, { capabilities: {} });
    await model.connect(toClient);

    const listed = await model.listTools();
    const shortLongName = listed.tools.find((t) => t.name.startsWith("add_single_recipe"))!.name;
    expect(shortLongName.length).toBeLessThanOrEqual(bareNameBudget("mealie"));

    const r1 = await model.callTool({ name: "get_all_recipes", arguments: {} });
    expect(JSON.stringify(r1.content)).toContain("recipes-ok");

    const r2 = await model.callTool({ name: shortLongName, arguments: { id: "42" } });
    expect(JSON.stringify(r2.content)).toContain("added-42");

    await proxy.close();
  });
});
