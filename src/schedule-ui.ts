import { InlineKeyboard } from "grammy";
import type { Schedule } from "./schedules";
import { nextRun } from "./scheduler";

/** callback_data prefix so we can tell our schedule buttons from anything else. */
const CB = "sch";
export type ScheduleAction = "run" | "pause" | "resume" | "del";

/** Encode a button action + schedule id into callback_data (well under 64 bytes). */
export function encodeCallback(action: ScheduleAction, id: string): string {
  return `${CB}:${action}:${id}`;
}

/** Parse callback_data back into an action + id, or null if it isn't ours. */
export function parseCallback(data: string): { action: ScheduleAction; id: string } | null {
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== CB) return null;
  const [, action, id] = parts;
  if (
    id === undefined ||
    (action !== "run" && action !== "pause" && action !== "resume" && action !== "del")
  ) {
    return null;
  }
  return { action, id };
}

function truncate(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function formatNext(schedule: Schedule): string {
  const next = nextRun(schedule);
  if (!next) return "no future run";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: schedule.timezone,
    timeZoneName: "short",
  }).format(next);
}

/**
 * Plain-text listing of a chat's schedules, numbered to match the button rows.
 * Sent without a parse mode, so no escaping is needed.
 */
export function renderScheduleList(schedules: Schedule[]): string {
  if (schedules.length === 0) {
    return "No scheduled prompts yet. Ask me to add one, e.g. “every Sunday at 5pm, plan next week’s meals”.";
  }
  const lines = schedules.map((s, i) => {
    const state = s.enabled ? "▶️ enabled" : "⏸ paused";
    return [
      `${i + 1}. ${state} · ${s.cron}${s.sessionMode === "continue" ? " · continues chat" : ""}`,
      `   “${truncate(s.prompt)}”`,
      `   next: ${s.enabled ? formatNext(s) : "—"}`,
    ].join("\n");
  });
  return `Scheduled prompts (${schedules.length}):\n\n${lines.join("\n\n")}`;
}

/**
 * One button row per schedule: run-now, pause/resume, and delete. Each row is
 * prefixed with the schedule's 1-based number so it lines up with the listing.
 */
export function buildScheduleKeyboard(schedules: Schedule[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  schedules.forEach((s, i) => {
    const n = i + 1;
    kb.text(`▶️ Run ${n}`, encodeCallback("run", s.id));
    if (s.enabled) {
      kb.text(`⏸ Pause ${n}`, encodeCallback("pause", s.id));
    } else {
      kb.text(`▶️ Resume ${n}`, encodeCallback("resume", s.id));
    }
    kb.text(`🗑 ${n}`, encodeCallback("del", s.id)).row();
  });
  return kb;
}
