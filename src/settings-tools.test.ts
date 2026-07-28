import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolSet } from "ai";
import { createSettingsStore, type SettingsStore } from "./settings";
import { createSettingsTools, resolveEffective, renderSettings, type SettingsDefaults } from "./settings-tools";
import type { GeocodeResult } from "./geocode";

const DEFAULTS: SettingsDefaults = {
  systemPrompt: "base prompt",
  homeLat: 48.496,
  homeLong: -123.393,
  timezone: "America/Vancouver",
  model: "google/gemini-2.5-flash",
  maxSteps: 12,
};

function tempStore(): SettingsStore {
  const dir = mkdtempSync(join(tmpdir(), "house-bot-settings-tools-"));
  return createSettingsStore(join(dir, "settings.json"));
}

const NANAIMO: GeocodeResult = {
  name: "Nanaimo, British Columbia, CA",
  lat: 49.16,
  long: -123.94,
  timezone: "America/Vancouver",
};

const call = (t: ToolSet, name: string, args: unknown) =>
  (t[name]!.execute as (a: unknown, o: unknown) => Promise<any>)(args, {
    toolCallId: "t",
    messages: [],
  });

async function setup(geocodeImpl?: (p: string) => Promise<GeocodeResult | null>) {
  const store = tempStore();
  await store.load();
  const tools = createSettingsTools({ store, chatId: 1, defaults: DEFAULTS, geocodeImpl });
  return { store, tools };
}

describe("resolveEffective", () => {
  test("falls back to defaults when nothing is overridden", () => {
    expect(resolveEffective(DEFAULTS, {})).toEqual({
      systemPrompt: "base prompt",
      lat: 48.496,
      long: -123.393,
      locationName: undefined,
      timezone: "America/Vancouver",
      modelSlug: undefined,
      maxSteps: 12,
    });
  });

  test("applies per-chat overrides", () => {
    const eff = resolveEffective(DEFAULTS, {
      systemPrompt: "custom",
      location: { name: "Tofino", lat: 49.15, long: -125.9 },
      model: "anthropic/claude-sonnet-4.5",
      maxSteps: 20,
    });
    expect(eff.systemPrompt).toBe("custom");
    expect(eff.lat).toBe(49.15);
    expect(eff.locationName).toBe("Tofino");
    expect(eff.modelSlug).toBe("anthropic/claude-sonnet-4.5");
    expect(eff.maxSteps).toBe(20);
  });
});

describe("renderSettings", () => {
  test("marks overridden vs default values", () => {
    const text = renderSettings(DEFAULTS, { timezone: "UTC" });
    expect(text).toContain("Timezone: UTC — custom");
    expect(text).toContain("Model: google/gemini-2.5-flash — default");
  });
});

describe("update_settings", () => {
  test("geocodes a place into location and adopts its timezone", async () => {
    const { store, tools } = await setup(async () => NANAIMO);
    const res = await call(tools, "update_settings", { place: "Nanaimo" });
    expect(res.ok).toBe(true);
    expect(store.get(1).location).toEqual({ name: NANAIMO.name, lat: 49.16, long: -123.94 });
    expect(store.get(1).timezone).toBe("America/Vancouver");
  });

  test("an explicit timezone is not overwritten by the geocoded one", async () => {
    const { store, tools } = await setup(async () => NANAIMO);
    await call(tools, "update_settings", { place: "Nanaimo", timezone: "UTC" });
    expect(store.get(1).timezone).toBe("UTC");
  });

  test("reports a place it can't find", async () => {
    const { store, tools } = await setup(async () => null);
    const res = await call(tools, "update_settings", { place: "Nowhere" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Couldn't find");
    expect(store.get(1)).toEqual({});
  });

  test("sets scalar overrides", async () => {
    const { store, tools } = await setup();
    await call(tools, "update_settings", { model: "anthropic/claude-sonnet-4.5", maxSteps: 20 });
    expect(store.get(1)).toEqual({ model: "anthropic/claude-sonnet-4.5", maxSteps: 20 });
  });

  test("rejects an empty update", async () => {
    const { tools } = await setup();
    const res = await call(tools, "update_settings", {});
    expect(res.ok).toBe(false);
  });
});

describe("reset_settings", () => {
  test("clears the named keys", async () => {
    const { store, tools } = await setup();
    await store.update(1, { timezone: "UTC", model: "x" });
    await call(tools, "reset_settings", { keys: ["timezone"] });
    expect(store.get(1)).toEqual({ model: "x" });
  });

  test("wipes everything when no keys are given", async () => {
    const { store, tools } = await setup();
    await store.update(1, { timezone: "UTC", model: "x" });
    await call(tools, "reset_settings", {});
    expect(store.get(1)).toEqual({});
  });
});
