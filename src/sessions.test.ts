import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./sessions";

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "house-bot-sessions-"));
  return join(dir, "sessions.json");
}

describe("createSessionStore", () => {
  test("set then get roundtrips the value", async () => {
    const store = createSessionStore(tempFile());
    await store.load();
    await store.set(1, "session-a");
    expect(store.get(1)).toBe("session-a");
  });

  test("get returns undefined for unknown chat id", async () => {
    const store = createSessionStore(tempFile());
    await store.load();
    expect(store.get(999)).toBeUndefined();
  });

  test("clear removes the session for a chat id", async () => {
    const store = createSessionStore(tempFile());
    await store.load();
    await store.set(1, "session-a");
    await store.clear(1);
    expect(store.get(1)).toBeUndefined();
  });

  test("load reads an existing json file", async () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ "42": "session-xyz" }));
    const store = createSessionStore(file);
    await store.load();
    expect(store.get(42)).toBe("session-xyz");
  });

  test("load is a no-op when the file is missing", async () => {
    const file = tempFile();
    const store = createSessionStore(file);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.get(1)).toBeUndefined();
  });

  test("set with an unchanged value skips the write", async () => {
    const file = tempFile();
    const store = createSessionStore(file);
    await store.load();
    await store.set(1, "session-a");
    const mtimeAfterFirstWrite = readFileSync(file).length > 0;
    expect(mtimeAfterFirstWrite).toBe(true);

    const before = readFileSync(file, "utf8");
    await store.set(1, "session-a");
    const after = readFileSync(file, "utf8");
    expect(after).toBe(before);
  });

  test("atomic write never leaves a partial file (no leftover tmp file)", async () => {
    const file = tempFile();
    const store = createSessionStore(file);
    await store.load();
    await store.set(1, "session-a");
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const contents = JSON.parse(readFileSync(file, "utf8"));
    expect(contents).toEqual({ "1": "session-a" });
  });
});
