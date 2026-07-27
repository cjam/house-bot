import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ScheduleStore, Schedule } from "./schedules";
import { type Scheduler, validateCron, nextRun } from "./scheduler";

/** Compact view of a schedule for the model, including its next fire time. */
function summarize(schedule: Schedule) {
  return {
    id: schedule.id,
    cron: schedule.cron,
    prompt: schedule.prompt,
    enabled: schedule.enabled,
    sessionMode: schedule.sessionMode,
    timezone: schedule.timezone,
    nextRun: nextRun(schedule)?.toISOString() ?? null,
    lastRunAt: schedule.lastRunAt ? new Date(schedule.lastRunAt).toISOString() : null,
  };
}

type ScheduleToolsDeps = {
  store: ScheduleStore;
  scheduler: Scheduler;
  /** The chat these tools manage schedules for. */
  chatId: number;
  /** Timezone stamped on new schedules when the model doesn't specify one. */
  defaultTimezone?: string;
};

/**
 * Internal agent tools for managing this chat's schedules by natural language
 * ("every Sunday at 5pm, plan next week's meals"). Bound to a single chatId so a
 * chat can only see and touch its own schedules. Every mutation calls
 * `scheduler.sync` so the running timers reflect the change immediately.
 */
export function createScheduleTools(deps: ScheduleToolsDeps): ToolSet {
  const { store, scheduler, chatId, defaultTimezone } = deps;

  /** Resolve an id to a schedule this chat owns, or null. */
  const owned = (id: string): Schedule | null => {
    const schedule = store.get(id);
    return schedule && schedule.chatId === chatId ? schedule : null;
  };

  return {
    list_schedules: tool({
      description:
        "List the scheduled prompts for this chat. Each fires its prompt on a cron " +
        "schedule and sends the reply here.",
      inputSchema: z.object({}),
      execute: async () => ({ schedules: store.list(chatId).map(summarize) }),
    }),

    create_schedule: tool({
      description:
        "Create a scheduled prompt for this chat. The prompt runs on the cron schedule " +
        "as if the user had sent it, and the reply is delivered to this chat. Use this " +
        'for recurring tasks like "every Sunday at 5pm, start planning next week\'s meals".',
      inputSchema: z.object({
        cron: z
          .string()
          .describe("Standard 5-field cron expression: minute hour day month weekday. e.g. '0 17 * * 0' = Sundays 17:00."),
        prompt: z.string().describe("The instruction to run when the schedule fires."),
        sessionMode: z
          .enum(["fresh", "continue"])
          .optional()
          .describe(
            "'fresh' (default) runs in isolation without touching the ongoing chat; " +
              "'continue' resumes this chat's current conversation.",
          ),
        timezone: z
          .string()
          .optional()
          .describe("IANA timezone for the cron expression, e.g. 'America/Vancouver'. Defaults to the bot's timezone."),
      }),
      execute: async ({ cron, prompt, sessionMode, timezone }) => {
        const tz = timezone ?? defaultTimezone;
        const error = validateCron(cron, tz);
        if (error) return { ok: false, error: `Invalid cron expression: ${error}` };
        const schedule = await store.add({ chatId, cron, prompt, sessionMode, timezone: tz });
        scheduler.sync(schedule.id);
        return { ok: true, schedule: summarize(schedule) };
      },
    }),

    toggle_schedule: tool({
      description: "Enable or disable (pause) a schedule by id without deleting it.",
      inputSchema: z.object({
        id: z.string(),
        enabled: z.boolean(),
      }),
      execute: async ({ id, enabled }) => {
        if (!owned(id)) return { ok: false, error: "No such schedule for this chat." };
        const updated = await store.update(id, { enabled });
        scheduler.sync(id);
        return { ok: true, schedule: updated ? summarize(updated) : null };
      },
    }),

    delete_schedule: tool({
      description: "Permanently delete a schedule by id.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        if (!owned(id)) return { ok: false, error: "No such schedule for this chat." };
        await store.remove(id);
        scheduler.sync(id);
        return { ok: true };
      },
    }),
  };
}
