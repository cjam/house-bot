import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Config } from "./config";
import type { ChatSettings, SettingsStore } from "./settings";
import { geocode, type GeocodeResult } from "./geocode";

/** The subset of config that supplies defaults for the per-chat overrides. */
export type SettingsDefaults = Pick<
  Config,
  "systemPrompt" | "homeLat" | "homeLong" | "timezone" | "model" | "maxSteps"
>;

/** A chat's settings resolved against the deployment defaults, used per turn. */
export type EffectiveSettings = {
  systemPrompt: string;
  lat: number;
  long: number;
  locationName?: string;
  timezone?: string;
  /** Model slug, or undefined to use the provider default. */
  modelSlug?: string;
  maxSteps: number;
};

/** Layer a chat's overrides over the deployment defaults. */
export function resolveEffective(defaults: SettingsDefaults, settings: ChatSettings): EffectiveSettings {
  return {
    systemPrompt: settings.systemPrompt ?? defaults.systemPrompt,
    lat: settings.location?.lat ?? defaults.homeLat,
    long: settings.location?.long ?? defaults.homeLong,
    locationName: settings.location?.name,
    timezone: settings.timezone ?? defaults.timezone,
    modelSlug: settings.model,
    maxSteps: settings.maxSteps ?? defaults.maxSteps,
  };
}

/** Plain-text view of a chat's settings, marking each as custom or default. */
export function renderSettings(defaults: SettingsDefaults, settings: ChatSettings): string {
  const tag = (overridden: boolean) => (overridden ? "custom" : "default");
  const location = settings.location
    ? `${settings.location.name} (${settings.location.lat}, ${settings.location.long})`
    : `home (${defaults.homeLat}, ${defaults.homeLong})`;
  const prompt = settings.systemPrompt
    ? `custom (${settings.systemPrompt.length} chars)`
    : "default";
  return [
    "Settings for this chat:",
    `• Location: ${location} — ${tag(!!settings.location)}`,
    `• Timezone: ${settings.timezone ?? defaults.timezone ?? "UTC"} — ${tag(!!settings.timezone)}`,
    `• Model: ${settings.model ?? defaults.model} — ${tag(!!settings.model)}`,
    `• Max steps: ${settings.maxSteps ?? defaults.maxSteps} — ${tag(settings.maxSteps !== undefined)}`,
    `• System prompt: ${prompt}`,
    "",
    "Change these with /setlocation, /setprompt, or just ask me; /resetsettings to revert.",
  ].join("\n");
}

type SettingsToolsDeps = {
  store: SettingsStore;
  chatId: number;
  defaults: SettingsDefaults;
  /** Injectable geocoder for tests; defaults to the shared Open-Meteo one. */
  geocodeImpl?: (place: string) => Promise<GeocodeResult | null>;
};

const SETTING_KEYS = ["systemPrompt", "location", "timezone", "model", "maxSteps"] as const;

/**
 * Internal agent tools for viewing and changing this chat's settings by natural
 * language ("we moved, set our location to Nanaimo"; "use claude-sonnet-4.5
 * here"). Bound to a single chatId. Setting a location geocodes the place name
 * to coordinates and, unless a timezone is given too, adopts the place's tz.
 */
export function createSettingsTools(deps: SettingsToolsDeps): ToolSet {
  const { store, chatId, defaults } = deps;
  const doGeocode = deps.geocodeImpl ?? ((place: string) => geocode(place));

  return {
    get_settings: tool({
      description: "Show this chat's effective settings (location, timezone, model, prompt).",
      inputSchema: z.object({}),
      execute: async () => ({
        settings: resolveEffective(defaults, store.get(chatId)),
        overrides: store.get(chatId),
      }),
    }),

    update_settings: tool({
      description:
        "Change this chat's settings. Set 'place' to move the household's location (geocoded, " +
        "which also sets the timezone). Other fields override the deployment defaults for this chat.",
      inputSchema: z.object({
        place: z
          .string()
          .optional()
          .describe("Location by name, e.g. 'Nanaimo, BC'. Geocoded; also sets timezone unless one is given."),
        systemPrompt: z.string().optional().describe("Replace the base persona/instructions for this chat."),
        timezone: z.string().optional().describe("IANA timezone, e.g. 'America/Vancouver'."),
        model: z.string().optional().describe("Model slug in the provider's namespace, e.g. 'anthropic/claude-sonnet-4.5'."),
        maxSteps: z.number().int().min(1).max(50).optional().describe("Max steps in the tool loop (1-50)."),
      }),
      execute: async ({ place, systemPrompt, timezone, model, maxSteps }) => {
        const patch: ChatSettings = { systemPrompt, timezone, model, maxSteps };
        if (place !== undefined) {
          let hit: GeocodeResult | null;
          try {
            hit = await doGeocode(place);
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          if (!hit) return { ok: false, error: `Couldn't find a location named "${place}".` };
          patch.location = { name: hit.name, lat: hit.lat, long: hit.long };
          if (timezone === undefined && hit.timezone) patch.timezone = hit.timezone;
        }
        const hasChange = Object.values(patch).some((v) => v !== undefined);
        if (!hasChange) return { ok: false, error: "Nothing to update." };
        const updated = await store.update(chatId, patch);
        return { ok: true, settings: resolveEffective(defaults, updated) };
      },
    }),

    reset_settings: tool({
      description: "Revert settings to the deployment defaults — all of them, or just the named keys.",
      inputSchema: z.object({
        keys: z
          .array(z.enum(SETTING_KEYS))
          .optional()
          .describe("Which settings to clear; omit to reset everything for this chat."),
      }),
      execute: async ({ keys }) => {
        await store.clear(chatId, keys);
        return { ok: true, settings: resolveEffective(defaults, store.get(chatId)) };
      },
    }),
  };
}
