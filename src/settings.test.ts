import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsStore } from "./settings";

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "house-bot-settings-"));
  return join(dir, "settings.json");
}

describe("createSettingsStore", () => {
  test("get returns an empty object for an unknown chat", async () => {
    const store = createSettingsStore(tempFile());
    await store.load();
    expect(store.get(1)).toEqual({});
  });

  test("update merges patches and ignores undefined values", async () => {
    const store = createSettingsStore(tempFile());
    await store.load();
    await store.update(1, { timezone: "America/Vancouver", model: undefined });
    await store.update(1, { model: "anthropic/claude-sonnet-4.5" });
    expect(store.get(1)).toEqual({
      timezone: "America/Vancouver",
      model: "anthropic/claude-sonnet-4.5",
    });
  });

  test("clear with keys removes only those keys", async () => {
    const store = createSettingsStore(tempFile());
    await store.load();
    await store.update(1, { timezone: "UTC", maxSteps: 20 });
    await store.clear(1, ["timezone"]);
    expect(store.get(1)).toEqual({ maxSteps: 20 });
  });

  test("clear with no keys wipes the whole record", async () => {
    const store = createSettingsStore(tempFile());
    await store.load();
    await store.update(1, { timezone: "UTC" });
    await store.clear(1);
    expect(store.get(1)).toEqual({});
  });

  test("clearing the last key drops the record entirely", async () => {
    const store = createSettingsStore(tempFile());
    await store.load();
    await store.update(1, { timezone: "UTC" });
    await store.clear(1, ["timezone"]);
    expect(store.get(1)).toEqual({});
  });

  test("persists across reloads", async () => {
    const file = tempFile();
    const store = createSettingsStore(file);
    await store.load();
    await store.update(7, { location: { name: "Nanaimo, BC, CA", lat: 49.16, long: -123.94 } });

    const reopened = createSettingsStore(file);
    await reopened.load();
    expect(reopened.get(7).location?.name).toBe("Nanaimo, BC, CA");
  });

  test("load skips non-object records", async () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ "1": "nope", "2": { timezone: "UTC" } }));
    const store = createSettingsStore(file);
    await store.load();
    expect(store.get(1)).toEqual({});
    expect(store.get(2)).toEqual({ timezone: "UTC" });
  });
});
