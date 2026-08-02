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

/** A recurring schedule repeats on a cron expression; a one-off fires once. */
export type ScheduleKind = "recurring" | "once";

/** Fields common to both kinds of schedule. */
type ScheduleCommon = {
  id: string;
  /** The Telegram chat this schedule fires into. */
  chatId: number;
  /** The prompt run as if the user had sent it. */
  prompt: string;
  enabled: boolean;
  /** IANA timezone for the trigger; falls back to the process TZ. */
  timezone?: string;
  sessionMode: SessionMode;
  createdAt: number;
  /** Epoch ms of the last successful fire, or null if it has never run. */
  lastRunAt: number | null;
};

/**
 * A schedule is either recurring (a cron expression) or a one-off (a fixed
 * datetime). A one-off is deleted automatically once it fires. The two carry
 * different trigger fields, so the kind discriminant tells them apart.
 */
export type Schedule =
  | (ScheduleCommon & { kind: "recurring"; cron: string })
  | (ScheduleCommon & { kind: "once"; runAt: string });

/** The fields a caller supplies when adding a schedule; the rest are derived. */
export type ScheduleInput = {
  chatId: number;
  prompt: string;
  enabled?: boolean;
  timezone?: string;
  sessionMode?: SessionMode;
} & ({ kind: "recurring"; cron: string } | { kind: "once"; runAt: string });

/** The mutable fields a caller may patch — never the kind or its trigger. */
export type ScheduleUpdate = Partial<
  Pick<Schedule, "enabled" | "prompt" | "sessionMode" | "timezone" | "lastRunAt">
> & {
  /** New cron expression (recurring schedules only). */
  cron?: string;
  /** New one-off datetime (once schedules only). */
  runAt?: string;
};

export type ScheduleStore = {
  load(): Promise<void>;
  /** All schedules, or just one chat's, in creation order. */
  list(chatId?: number): Schedule[];
  get(id: string): Schedule | undefined;
  add(input: ScheduleInput): Promise<Schedule>;
  /** Applies a partial patch and persists; returns the updated record or undefined. */
  update(id: string, patch: ScheduleUpdate): Promise<Schedule | undefined>;
  remove(id: string): Promise<boolean>;
};

/** True if a loaded record has the shape of one of the two schedule kinds. */
function isSchedule(value: unknown): value is Schedule {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "once") return typeof v.runAt === "string";
  return typeof v.cron === "string"; // "recurring", or a legacy record (see load()).
}

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
        if (typeof value !== "object" || value === null) continue;
        const record = value as Record<string, unknown>;
        // Records written before one-offs existed have a `cron` but no `kind`;
        // treat them as recurring so they keep working across the upgrade.
        if (record.kind === undefined && typeof record.cron === "string") {
          record.kind = "recurring";
        }
        if (isSchedule(record)) schedules.set(id, record as Schedule);
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
      const common: ScheduleCommon = {
        id: randomUUID().slice(0, 8),
        chatId: input.chatId,
        prompt: input.prompt,
        enabled: input.enabled ?? true,
        timezone: input.timezone,
        sessionMode: input.sessionMode ?? "fresh",
        createdAt: Date.now(),
        lastRunAt: null,
      };
      const schedule: Schedule =
        input.kind === "once"
          ? { ...common, kind: "once", runAt: input.runAt }
          : { ...common, kind: "recurring", cron: input.cron };
      schedules.set(schedule.id, schedule);
      await persist();
      return schedule;
    },

    async update(id, patch) {
      const current = schedules.get(id);
      if (!current) return undefined;
      // Skip undefined values so a partial patch (e.g. only { prompt }) never
      // wipes the fields the caller left out.
      const updated = { ...current } as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) updated[key] = value;
      }
      schedules.set(id, updated as Schedule);
      await persist();
      return updated as Schedule;
    },

    async remove(id) {
      if (!schedules.delete(id)) return false;
      await persist();
      return true;
    },
  };
}
