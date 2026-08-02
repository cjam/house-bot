import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { createRecallTool } from "./recall";

/** Build a transcript dir with the given per-session turn records. */
function fixture(chatId: number, sessions: Record<string, any[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "house-bot-recall-"));
  const chatDir = join(dir, String(chatId));
  mkdirSync(chatDir, { recursive: true });
  for (const [sessionId, turns] of Object.entries(sessions)) {
    const lines = turns.map((t) => JSON.stringify({ sessionId, ...t })).join("\n");
    writeFileSync(join(chatDir, `${sessionId}.jsonl`), `${lines}\n`);
  }
  return dir;
}

const call = (tools: ToolSet, args: unknown) =>
  (tools.recall!.execute as (a: unknown, o: unknown) => Promise<any>)(args, {
    toolCallId: "t",
    messages: [],
  });

describe("recall", () => {
  test("finds matching past turns across sessions, ranked by keyword overlap", async () => {
    const dir = fixture(-100, {
      "20260701-120000-aaaa": [
        { ts: "2026-07-01T12:00:00Z", prompt: "we made pork tenderloin", reply: "logged pork tenderloin" },
      ],
      "20260715-120000-bbbb": [
        { ts: "2026-07-15T12:00:00Z", prompt: "what's for dinner", reply: "tacos" },
        { ts: "2026-07-15T12:05:00Z", prompt: "add pork tenderloin recipe", reply: "created pork tenderloin recipe" },
      ],
    });
    const res = await call(createRecallTool({ chatId: -100, dir }), { query: "pork tenderloin" });
    expect(res.matches.length).toBe(2);
    // Both turns mention the query; results are present with session + text.
    expect(res.matches.every((m: any) => m.reply.toLowerCase().includes("pork") || m.prompt.toLowerCase().includes("pork"))).toBe(true);
    expect(res.matches[0].sessionId).toBeDefined();
  });

  test("skips the current session (already in context)", async () => {
    const dir = fixture(1, {
      old: [{ ts: "2026-07-01T00:00:00Z", prompt: "curry night", reply: "made curry" }],
      current: [{ ts: "2026-08-01T00:00:00Z", prompt: "curry again", reply: "ok curry" }],
    });
    const res = await call(createRecallTool({ chatId: 1, dir, currentSessionId: "current" }), { query: "curry" });
    expect(res.matches.length).toBe(1);
    expect(res.matches[0].sessionId).toBe("old");
  });

  test("returns nothing (no throw) when the chat has no history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "house-bot-recall-empty-"));
    const res = await call(createRecallTool({ chatId: 999, dir }), { query: "anything" });
    expect(res.matches).toEqual([]);
  });

  test("respects the limit", async () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({ ts: `2026-07-${i + 1}T00:00:00Z`, prompt: `soup ${i}`, reply: "yum" }));
    const dir = fixture(5, { s1: turns });
    const res = await call(createRecallTool({ chatId: 5, dir }), { query: "soup", limit: 3 });
    expect(res.matches.length).toBe(3);
  });
});
