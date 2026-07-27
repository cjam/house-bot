import { Cron } from "croner";
import type { Schedule, ScheduleStore } from "./schedules";

/** The string croner schedules on: a cron expression, or a one-off's datetime. */
function patternOf(schedule: Schedule): string {
  return schedule.kind === "once" ? schedule.runAt : schedule.cron;
}

/**
 * Validate a cron expression (optionally for a given timezone) without
 * scheduling it. Returns null if valid, or a short error message. croner throws
 * on a malformed pattern or unknown timezone, which we surface to the caller.
 */
export function validateCron(pattern: string, timezone?: string): string | null {
  try {
    // Constructing catches a malformed pattern; computing a run catches a bad
    // timezone, which croner only validates lazily when it converts a date.
    new Cron(pattern, timezone ? { timezone } : {}).nextRun();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Validate a one-off datetime (ISO-8601, interpreted in `timezone`). Returns
 * null if valid, or a message. A time in the past is rejected: croner reports it
 * as "no next run", which for a one-off means it would never fire.
 */
export function validateOnce(runAt: string, timezone?: string): string | null {
  let next: Date | null;
  try {
    next = new Cron(runAt, timezone ? { timezone } : {}).nextRun();
  } catch (err) {
    return `Invalid datetime: ${err instanceof Error ? err.message : err}`;
  }
  return next === null ? "That time is in the past." : null;
}

/** The next fire time for a schedule, or null if it has no future occurrence. */
export function nextRun(schedule: Schedule, from?: Date): Date | null {
  const options = schedule.timezone ? { timezone: schedule.timezone } : {};
  return new Cron(patternOf(schedule), options).nextRun(from);
}

export type Scheduler = {
  /** Register every enabled schedule and fire any whose run was missed while down. */
  start(): Promise<void>;
  /** Reconcile one schedule's timer after it was added, changed, or removed. */
  sync(id: string): void;
  /** Fire a schedule immediately, regardless of its enabled state. */
  runNow(id: string): Promise<void>;
  stop(): void;
};

type SchedulerDeps = {
  store: ScheduleStore;
  /** Runs the schedule's turn. Thrown errors are caught and logged, not fatal. */
  onFire: (schedule: Schedule) => Promise<void>;
  log?: (line: string) => void;
  /** Injectable clock for tests. */
  now?: () => number;
};

/**
 * Owns a croner timer per enabled schedule. Timers look the schedule up from the
 * store at fire time (rather than closing over a snapshot), so edits take effect
 * without re-registering. Recurring runs stamp `lastRunAt` so a restart can tell
 * which they missed; one-offs (and any pattern with no next run) are deleted once
 * they fire, so they don't linger as dead records.
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { store, onFire } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const jobs = new Map<string, Cron>();

  function unregister(id: string): void {
    jobs.get(id)?.stop();
    jobs.delete(id);
  }

  function register(schedule: Schedule): void {
    unregister(schedule.id);
    const job = new Cron(
      patternOf(schedule),
      { timezone: schedule.timezone, protect: true },
      () => void fire(schedule.id),
    );
    jobs.set(schedule.id, job);
  }

  async function fire(id: string): Promise<void> {
    const schedule = store.get(id);
    if (!schedule) return;
    try {
      await onFire(schedule);
      // A one-off — or any schedule with nothing left to run — is done; drop it
      // and its timer. Recurring schedules just record when they last ran.
      if (schedule.kind === "once" || nextRun(schedule) === null) {
        unregister(id);
        await store.remove(id);
      } else {
        await store.update(id, { lastRunAt: now() });
      }
    } catch (err) {
      log(`Schedule "${id}" failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    async start() {
      for (const schedule of store.list()) {
        if (!schedule.enabled) continue;

        // A one-off whose time has already passed never registers. If it never
        // ran, fire it now (a run missed while we were down); either way `fire`
        // then cleans it up. A leftover already-run one-off is just removed.
        if (schedule.kind === "once" && nextRun(schedule) === null) {
          if (schedule.lastRunAt === null) {
            log(`Schedule "${schedule.id}": firing a missed one-off.`);
            await fire(schedule.id);
          } else {
            await store.remove(schedule.id);
          }
          continue;
        }

        register(schedule);

        // Catch up a recurring run missed while the process was down: the first
        // occurrence after the last successful run. Never-run recurring
        // schedules are left alone so a fresh deploy doesn't fire all at once.
        if (schedule.lastRunAt !== null) {
          const due = nextRun(schedule, new Date(schedule.lastRunAt));
          if (due && due.getTime() <= now()) {
            log(`Schedule "${schedule.id}": catching up a missed run.`);
            await fire(schedule.id);
          }
        }
      }
    },

    sync(id) {
      const schedule = store.get(id);
      if (!schedule || !schedule.enabled) {
        unregister(id);
        return;
      }
      register(schedule);
    },

    async runNow(id) {
      await fire(id);
    },

    stop() {
      for (const job of jobs.values()) job.stop();
      jobs.clear();
    },
  };
}
