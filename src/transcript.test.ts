import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriptLogger, type TurnRecord } from "./transcript";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "house-bot-transcript-"));
}

const record = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  ts: "2026-08-01T18:30:00.000Z",
  chatId: -100123,
  trigger: "message",
  fresh: false,
  priorMessages: 4,
  prompt: "what's for dinner?",
  reply: "Tacos.",
  tools: [{ name: "get_forecast", args: { days: 3 } }],
  model: "anthropic/claude-haiku-4.5",
  usage: { inputTokens: 10, outputTokens: 3 },
  steps: 2,
  ms: 1500,
  ...over,
});

describe("createTranscriptLogger", () => {
  test("is a no-op when no directory is configured", async () => {
    const logger = createTranscriptLogger(undefined);
    await expect(logger.log(record())).resolves.toBeUndefined();
  });

  test("appends one JSON line per turn to a per-chat file", async () => {
    const dir = tempDir();
    const logger = createTranscriptLogger(dir);
    await logger.log(record({ chatId: -100123, prompt: "first" }));
    await logger.log(record({ chatId: -100123, prompt: "second" }));

    const lines = readFileSync(join(dir, "-100123.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).prompt).toBe("first");
    expect(JSON.parse(lines[1]!)).toMatchObject({ prompt: "second", tools: [{ name: "get_forecast" }] });
  });

  test("separates chats into their own files", async () => {
    const dir = tempDir();
    const logger = createTranscriptLogger(dir);
    await logger.log(record({ chatId: 1 }));
    await logger.log(record({ chatId: 2 }));
    expect(existsSync(join(dir, "1.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "2.jsonl"))).toBe(true);
  });

  test("never throws on a write failure (directory path is a file)", async () => {
    const dir = tempDir();
    // Point the logger at a path that can't be a directory to force a failure.
    const badLogger = createTranscriptLogger(join(dir, "-100123.jsonl", "nested"));
    await createTranscriptLogger(dir).log(record());
    await expect(badLogger.log(record())).resolves.toBeUndefined();
  });
});
