import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** One appended line of the transcript log: everything about a single turn. */
export type TurnRecord = {
  ts: string;
  chatId: number;
  /** The session this turn belongs to; also the transcript file it's written to. */
  sessionId: string;
  /** What drove the turn: an interactive message or a fired schedule. */
  trigger: "message" | "schedule";
  /** True when the turn started from an empty history (no prior context loaded). */
  fresh: boolean;
  /** How many messages of context were loaded going in. */
  priorMessages: number;
  prompt: string;
  reply: string;
  /** Tools the model called this turn, in order. */
  tools: { name: string; args: unknown }[];
  model: string;
  usage?: unknown;
  steps?: number;
  /** True when the turn was cut off at the maxSteps cap (see AskResult.truncated). */
  truncated?: boolean;
  /** Wall-clock duration of the agent turn, milliseconds. */
  ms: number;
};

export type TranscriptLogger = {
  /** Append one turn record. Never throws — a logging failure must not fail a turn. */
  log(record: TurnRecord): Promise<void>;
};

/**
 * An append-only, per-session JSONL transcript for analysis (prompt tuning, tool
 * usage, cost, latency, and how often sessions start fresh vs. resumed). One file
 * per session at `<dir>/<chatId>/<sessionId>.jsonl`, one JSON object per line —
 * so files stay small and each session is a self-contained unit to drill into.
 * Disabled (a no-op) when no directory is configured, so it's strictly opt-in.
 */
export function createTranscriptLogger(dir: string | undefined): TranscriptLogger {
  if (!dir) return { async log() {} };
  return {
    async log(record) {
      try {
        const chatDir = join(dir, String(record.chatId));
        await mkdir(chatDir, { recursive: true });
        await appendFile(join(chatDir, `${record.sessionId}.jsonl`), `${JSON.stringify(record)}\n`);
      } catch (err) {
        console.error("Transcript log failed:", err instanceof Error ? err.message : err);
      }
    },
  };
}
