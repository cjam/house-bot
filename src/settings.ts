import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** A resolved location for a chat (from geocoding a place name, or explicit coords). */
export type ChatLocation = { name: string; lat: number; long: number };

/**
 * Per-chat overrides layered over the deployment defaults (from `.env`). Every
 * field is optional; an absent field means "use the default". Resolving these
 * against the config happens in settings-tools' `resolveEffective`.
 */
export type ChatSettings = {
  /** Overrides the base system prompt / persona. */
  systemPrompt?: string;
  /** Home location for the weather tool. */
  location?: ChatLocation;
  /** IANA timezone for the injected date and new schedules. */
  timezone?: string;
  /** Model slug (in the active provider's namespace). */
  model?: string;
  /** Max steps in the agentic tool loop. */
  maxSteps?: number;
};

/** The keys a caller may target when clearing overrides. */
export type SettingKey = keyof ChatSettings;

export type SettingsStore = {
  load(): Promise<void>;
  /** The chat's overrides, or an empty object if it has none. */
  get(chatId: number): ChatSettings;
  /** Merge in the given overrides (undefined values are ignored) and persist. */
  update(chatId: number, patch: ChatSettings): Promise<ChatSettings>;
  /** Clear specific override keys, or the chat's whole record when keys is omitted. */
  clear(chatId: number, keys?: SettingKey[]): Promise<void>;
};

/**
 * Persists chat_id -> ChatSettings to a JSON file, following the same
 * atomic-write, load-on-boot pattern as the session and schedule stores. Kept
 * separate from those on purpose: settings are cold (rarely written), so folding
 * them into the per-message session record would rewrite them on every message.
 */
export function createSettingsStore(filePath: string): SettingsStore {
  const settings = new Map<number, ChatSettings>();

  async function persist(): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const data: Record<string, ChatSettings> = {};
    for (const [chatId, record] of settings) data[String(chatId)] = record;
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2));
    await rename(tmpPath, filePath);
  }

  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      const data = JSON.parse(raw) as Record<string, unknown>;
      for (const [chatId, value] of Object.entries(data)) {
        if (typeof value === "object" && value !== null) {
          settings.set(Number(chatId), value as ChatSettings);
        }
      }
    },

    get(chatId) {
      return settings.get(chatId) ?? {};
    },

    async update(chatId, patch) {
      const merged: ChatSettings = { ...settings.get(chatId) };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
      }
      settings.set(chatId, merged);
      await persist();
      return merged;
    },

    async clear(chatId, keys) {
      const current = settings.get(chatId);
      if (!current) return;
      if (!keys) {
        settings.delete(chatId);
      } else {
        for (const key of keys) delete current[key];
        if (Object.keys(current).length === 0) settings.delete(chatId);
      }
      await persist();
    },
  };
}
