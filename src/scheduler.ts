import { Cron } from "croner";
import type { Schedule, ScheduleStore } from "./schedules";

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

/** The next fire time for a schedule, or null if it has no future occurrence. */
export function nextRun(schedule: Schedule, from?: Date): Date | null {
  return new Cron(schedule.cron, schedule.timezone ? { timezone: schedule.timezone } : {}).nextRun(
    from,
  );
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
 * without re-registering, and `lastRunAt` is stamped after each successful run so
 * a restart can tell which runs it missed.
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { store, onFire } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const jobs = new Map<string, Cron>();

  async function fire(id: string): Promise<void> {
    const schedule = store.get(id);
    if (!schedule) return;
    try {
      await onFire(schedule);
      await store.update(id, { lastRunAt: now() });
    } catch (err) {
      log(`Schedule "${id}" failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  function unregister(id: string): void {
    jobs.get(id)?.stop();
    jobs.delete(id);
  }

  function register(schedule: Schedule): void {
    unregister(schedule.id);
    const job = new Cron(
      schedule.cron,
      { timezone: schedule.timezone, protect: true },
      () => void fire(schedule.id),
    );
    jobs.set(schedule.id, job);
  }

  return {
    async start() {
      for (const schedule of store.list()) {
        if (!schedule.enabled) continue;
        register(schedule);
        // Catch up a run missed while the process was down: the first scheduled
        // occurrence after the last successful run. Schedules that have never
        // run are left alone so a fresh deploy doesn't fire everything at once.
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
