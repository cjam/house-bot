import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ScheduleStore, Schedule, ScheduleUpdate } from "./schedules";
import { type Scheduler, validateCron, validateOnce, nextRun } from "./scheduler";

/** Compact view of a schedule for the model, including its next fire time. */
function summarize(schedule: Schedule) {
  return {
    id: schedule.id,
    kind: schedule.kind,
    ...(schedule.kind === "once" ? { runAt: schedule.runAt } : { cron: schedule.cron }),
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
        "Create a NEW scheduled prompt for this chat. First call list_schedules — if one that " +
        "serves the same purpose already exists, use update_schedule to change it instead of " +
        "adding a duplicate. The prompt runs as if the user had sent it, and the reply is " +
        "delivered to this chat. Use kind='recurring' with a cron expression for repeating tasks " +
        '("every Sunday at 5pm, plan next week\'s meals"), or kind=\'once\' with a datetime for a ' +
        "one-time reminder that auto-deletes after it fires.",
      inputSchema: z.object({
        kind: z
          .enum(["recurring", "once"])
          .describe("'recurring' repeats on a cron schedule; 'once' fires a single time then deletes itself."),
        cron: z
          .string()
          .optional()
          .describe(
            "Required when kind='recurring'. 5-field cron expression: minute hour day month " +
              "weekday. e.g. '0 17 * * 0' = Sundays 17:00.",
          ),
        runAt: z
          .string()
          .optional()
          .describe(
            "Required when kind='once'. Local ISO-8601 datetime, e.g. '2026-07-28T17:00'. " +
              "Interpreted in the schedule's timezone; must be in the future.",
          ),
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
          .describe("IANA timezone for the trigger, e.g. 'America/Vancouver'. Defaults to the bot's timezone."),
      }),
      execute: async ({ kind, cron, runAt, prompt, sessionMode, timezone }) => {
        const tz = timezone ?? defaultTimezone;
        if (kind === "once") {
          if (!runAt) return { ok: false, error: "runAt is required for a one-off schedule." };
          const error = validateOnce(runAt, tz);
          if (error) return { ok: false, error };
          const schedule = await store.add({ kind, chatId, runAt, prompt, sessionMode, timezone: tz });
          scheduler.sync(schedule.id);
          return { ok: true, schedule: summarize(schedule) };
        }
        if (!cron) return { ok: false, error: "cron is required for a recurring schedule." };
        const error = validateCron(cron, tz);
        if (error) return { ok: false, error: `Invalid cron expression: ${error}` };
        const schedule = await store.add({ kind, chatId, cron, prompt, sessionMode, timezone: tz });
        scheduler.sync(schedule.id);
        return { ok: true, schedule: summarize(schedule) };
      },
    }),

    update_schedule: tool({
      description:
        "Change an EXISTING schedule (by id) in place — its time (cron/runAt), prompt, session " +
        "mode, timezone, or enabled state. Prefer this over create_schedule whenever the user " +
        "wants to change a schedule that already exists (call list_schedules first to get the id). " +
        "Only the fields you pass change.",
      inputSchema: z.object({
        id: z.string(),
        cron: z.string().optional().describe("New cron expression (recurring schedules only)."),
        runAt: z.string().optional().describe("New ISO-8601 datetime (one-off schedules only)."),
        prompt: z.string().optional().describe("Replace the prompt that runs."),
        sessionMode: z
          .enum(["fresh", "continue"])
          .optional()
          .describe("'fresh' runs isolated; 'continue' resumes this chat's conversation."),
        enabled: z.boolean().optional().describe("Enable or pause the schedule."),
        timezone: z.string().optional().describe("IANA timezone for the trigger."),
      }),
      execute: async ({ id, cron, runAt, prompt, sessionMode, enabled, timezone }) => {
        const schedule = owned(id);
        if (!schedule) return { ok: false, error: "No such schedule for this chat." };
        const tz = timezone ?? schedule.timezone;
        const patch: ScheduleUpdate = { prompt, sessionMode, enabled, timezone };
        if (cron !== undefined) {
          if (schedule.kind !== "recurring") {
            return { ok: false, error: "cron only applies to recurring schedules." };
          }
          const error = validateCron(cron, tz);
          if (error) return { ok: false, error: `Invalid cron expression: ${error}` };
          patch.cron = cron;
        }
        if (runAt !== undefined) {
          if (schedule.kind !== "once") {
            return { ok: false, error: "runAt only applies to one-off schedules." };
          }
          const error = validateOnce(runAt, tz);
          if (error) return { ok: false, error };
          patch.runAt = runAt;
        }
        if (!Object.values(patch).some((v) => v !== undefined)) {
          return { ok: false, error: "Nothing to update." };
        }
        const updated = await store.update(id, patch);
        scheduler.sync(id);
        return { ok: true, schedule: updated ? summarize(updated) : null };
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
