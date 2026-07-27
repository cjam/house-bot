import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Whether a fired schedule runs in isolation or against the chat's live
 * conversation. `fresh` starts from an empty history and does not touch the
 * interactive session — so a weekly "plan the meals" prompt never pollutes an
 * ongoing chat. `continue` resumes (and updates) the chat's current session.
 */
export type SessionMode = "fresh" | "continue";

export type Schedule = {
  id: string;
  /** The Telegram chat this schedule fires into. */
  chatId: number;
  /** Standard 5-field cron expression (minute hour day month weekday). */
  cron: string;
  /** The prompt run as if the user had sent it. */
  prompt: string;
  enabled: boolean;
  /** IANA timezone for the cron expression; falls back to the process TZ. */
  timezone?: string;
  sessionMode: SessionMode;
  createdAt: number;
  /** Epoch ms of the last successful fire, or null if it has never run. */
  lastRunAt: number | null;
};

/** The fields a caller supplies when adding a schedule; the rest are derived. */
export type ScheduleInput = {
  chatId: number;
  cron: string;
  prompt: string;
  enabled?: boolean;
  timezone?: string;
  sessionMode?: SessionMode;
};

export type ScheduleStore = {
  load(): Promise<void>;
  /** All schedules, or just one chat's, in creation order. */
  list(chatId?: number): Schedule[];
  get(id: string): Schedule | undefined;
  add(input: ScheduleInput): Promise<Schedule>;
  /** Applies a partial patch and persists; returns the updated record or undefined. */
  update(id: string, patch: Partial<Omit<Schedule, "id">>): Promise<Schedule | undefined>;
  remove(id: string): Promise<boolean>;
};

/**
 * Persists id -> Schedule to a JSON file, following the same atomic-write,
 * load-on-boot pattern as the session store. Insertion order is preserved so
 * listings are stable.
 */
export function createScheduleStore(filePath: string): ScheduleStore {
  const schedules = new Map<string, Schedule>();

  async function persist(): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const data: Record<string, Schedule> = {};
    for (const [id, record] of schedules) data[id] = record;
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
      for (const [id, value] of Object.entries(data)) {
        if (
          typeof value === "object" &&
          value !== null &&
          typeof (value as Schedule).cron === "string"
        ) {
          schedules.set(id, value as Schedule);
        }
      }
    },

    list(chatId) {
      const all = [...schedules.values()];
      return chatId === undefined ? all : all.filter((s) => s.chatId === chatId);
    },

    get(id) {
      return schedules.get(id);
    },

    async add(input) {
      const schedule: Schedule = {
        id: randomUUID().slice(0, 8),
        chatId: input.chatId,
        cron: input.cron,
        prompt: input.prompt,
        enabled: input.enabled ?? true,
        timezone: input.timezone,
        sessionMode: input.sessionMode ?? "fresh",
        createdAt: Date.now(),
        lastRunAt: null,
      };
      schedules.set(schedule.id, schedule);
      await persist();
      return schedule;
    },

    async update(id, patch) {
      const current = schedules.get(id);
      if (!current) return undefined;
      const updated = { ...current, ...patch, id };
      schedules.set(id, updated);
      await persist();
      return updated;
    },

    async remove(id) {
      if (!schedules.delete(id)) return false;
      await persist();
      return true;
    },
  };
}
