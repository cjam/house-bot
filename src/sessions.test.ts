import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { createSessionStore } from "./sessions";

const IDLE_MS = 15 * 60_000;

/** A minimal one-message history to round-trip. */
const history = (text: string): ModelMessage[] => [{ role: "user", content: text }];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "house-bot-sessions-"));
  return join(dir, "sessions.json");
}

describe("createSessionStore", () => {
  test("set then get roundtrips the message history", async () => {
    const store = createSessionStore(tempFile(), IDLE_MS);
    await store.load();
    await store.set(1, history("session-a"));
    expect(store.get(1)).toEqual(history("session-a"));
  });

  test("get returns undefined for unknown chat id", async () => {
    const store = createSessionStore(tempFile(), IDLE_MS);
    await store.load();
    expect(store.get(999)).toBeUndefined();
  });

  test("clear removes the session for a chat id", async () => {
    const store = createSessionStore(tempFile(), IDLE_MS);
    await store.load();
    await store.set(1, history("session-a"));
    await store.clear(1);
    expect(store.get(1)).toBeUndefined();
  });

  test("load reads an existing json file", async () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({ "42": { messages: history("session-xyz"), lastMessageAt: 1000 } }),
    );
    const store = createSessionStore(file, IDLE_MS);
    await store.load();
    expect(store.get(42, 1000)).toEqual(history("session-xyz"));
  });

  test("load skips the old session-id formats (bare string and { sessionId })", async () => {
    const file = tempFile();
    writeFileSync(
      file,
      JSON.stringify({ "1": "old-session", "2": { sessionId: "old", lastMessageAt: 1000 } }),
    );
    const store = createSessionStore(file, IDLE_MS);
    await store.load();
    expect(store.get(1, 1000)).toBeUndefined();
    expect(store.get(2, 1000)).toBeUndefined();
  });

  test("load is a no-op when the file is missing", async () => {
    const file = tempFile();
    const store = createSessionStore(file, IDLE_MS);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.get(1)).toBeUndefined();
  });

  test("get returns the history within the idle window", async () => {
    const store = createSessionStore(tempFile(), IDLE_MS);
    await store.load();
    await store.set(1, history("session-a"), 0);
    expect(store.get(1, IDLE_MS)).toEqual(history("session-a"));
  });

  test("get returns undefined once the idle window has elapsed", async () => {
    const store = createSessionStore(tempFile(), IDLE_MS);
    await store.load();
    await store.set(1, history("session-a"), 0);
    expect(store.get(1, IDLE_MS + 1)).toBeUndefined();
  });

  test("set refreshes the idle clock", async () => {
    const store = createSessionStore(tempFile(), IDLE_MS);
    await store.load();
    await store.set(1, history("session-a"), 0);
    await store.set(1, history("session-a"), IDLE_MS); // a message right at the old deadline
    expect(store.get(1, IDLE_MS + IDLE_MS)).toEqual(history("session-a")); // clock reset, still alive
  });

  test("atomic write never leaves a partial file (no leftover tmp file)", async () => {
    const file = tempFile();
    const store = createSessionStore(file, IDLE_MS);
    await store.load();
    await store.set(1, history("session-a"), 1000);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const contents = JSON.parse(readFileSync(file, "utf8"));
    expect(contents["1"].messages).toEqual(history("session-a"));
    expect(contents["1"].lastMessageAt).toBe(1000);
    expect(typeof contents["1"].sessionId).toBe("string");
  });

  test("keeps the session id across active turns but mints a new one after an idle gap", async () => {
    const store = createSessionStore(tempFile(), IDLE_MS);
    await store.load();
    const first = await store.set(1, history("a"), 0);
    const same = await store.set(1, history("b"), IDLE_MS); // within the window
    const next = await store.set(1, history("c"), IDLE_MS + IDLE_MS + 1); // after a gap
    expect(same).toBe(first);
    expect(next).not.toBe(first);
    expect(next).toMatch(/^\d{8}-\d{6}-[0-9a-f]{4}$/);
  });
});
