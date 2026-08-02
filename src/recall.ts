import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

function truncate(text: unknown, max: number): string {
  const s = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

type Match = { ts: string; sessionId: string; score: number; prompt: string; reply: string };

/**
 * Search this chat's transcript files for turns matching a query. Deterministic
 * keyword scoring over `<dir>/<chatId>/<sessionId>.jsonl` — no model call. The
 * current session is skipped (its turns are already in context). Returns the
 * top matches, so a large history never floods the caller.
 */
async function searchHistory(
  dir: string,
  chatId: number,
  query: string,
  limit: number,
  skipSessionId?: string,
): Promise<Match[]> {
  const chatDir = join(dir, String(chatId));
  let files: string[];
  try {
    files = (await readdir(chatDir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return []; // no history for this chat yet
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const matches: Match[] = [];
  for (const file of files) {
    if (skipSessionId && file === `${skipSessionId}.jsonl`) continue;
    let content: string;
    try {
      content = await readFile(join(chatDir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const hay = `${rec.prompt ?? ""}\n${rec.reply ?? ""}`.toLowerCase();
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      if (score > 0) {
        matches.push({ ts: rec.ts, sessionId: rec.sessionId, score, prompt: rec.prompt, reply: rec.reply });
      }
    }
  }
  // Best keyword overlap first, then most recent.
  matches.sort((a, b) => b.score - a.score || (a.ts < b.ts ? 1 : -1));
  return matches.slice(0, limit);
}

/**
 * A `recall` tool bound to one chat that searches its past sessions. Lets the
 * model look up a fact or decision from an earlier conversation that has since
 * fallen out of the live session, instead of claiming it doesn't know.
 */
export function createRecallTool(deps: {
  chatId: number;
  dir: string;
  currentSessionId?: string;
}): ToolSet {
  return {
    recall: tool({
      description:
        "Search this chat's earlier conversations (past sessions, beyond the current context) for " +
        "a fact, decision, or detail — e.g. something discussed days or weeks ago. Use it before " +
        "telling the user you have no record of something. Returns matching past turns.",
      inputSchema: z.object({
        query: z.string().describe("Keywords to search past turns for."),
        limit: z.number().int().min(1).max(20).optional().describe("Max matches to return (default 8)."),
      }),
      execute: async ({ query, limit }) => {
        const found = await searchHistory(deps.dir, deps.chatId, query, limit ?? 8, deps.currentSessionId);
        return {
          matches: found.map((m) => ({
            ts: m.ts,
            sessionId: m.sessionId,
            prompt: truncate(m.prompt, 200),
            reply: truncate(m.reply, 300),
          })),
        };
      },
    }),
  };
}
