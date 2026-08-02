import { InlineKeyboard } from "grammy";
import type { PlanDay, PlanDraft } from "./plan-draft";

/** callback_data prefix so we can tell our plan buttons from schedule buttons. */
const CB = "mp";
/** Actions that target one day (carry a day index) vs. the whole draft. */
export type PlanDayAction = "shuffle" | "skip" | "unskip";
export type PlanAction = PlanDayAction | "all" | "lock";
const DAY_ACTIONS: PlanDayAction[] = ["shuffle", "skip", "unskip"];

/**
 * Encode a plan-card action into callback_data. Day actions (shuffle/skip/unskip)
 * target a specific day by index; `all` and `lock` act on the whole draft. All
 * forms stay well under Telegram's 64-byte limit (the id is 8 chars).
 */
export function encodePlanCallback(action: PlanAction, id: string, dayIndex?: number): string {
  return (DAY_ACTIONS as string[]).includes(action) ? `${CB}:${action}:${id}:${dayIndex}` : `${CB}:${action}:${id}`;
}

/** Parse plan callback_data back into an action (+ day for day actions), or null if it isn't ours. */
export function parsePlanCallback(data: string): { action: PlanAction; id: string; dayIndex?: number } | null {
  const parts = data.split(":");
  if (parts[0] !== CB) return null;
  const [, action, id, day] = parts;
  if (action === undefined || id === undefined) return null;
  if ((DAY_ACTIONS as string[]).includes(action)) {
    const dayIndex = Number(day);
    if (parts.length !== 4 || !Number.isInteger(dayIndex)) return null;
    return { action: action as PlanDayAction, id, dayIndex };
  }
  if ((action === "all" || action === "lock") && parts.length === 3) {
    return { action, id };
  }
  return null;
}

/** "2026-08-03" → "Mon Aug 3" (weekday + date), treating the string as a calendar date. */
function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(dt);
}

/** "Mon" — the short weekday alone, for compact shuffle buttons. */
function weekday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(dt);
}

/** The weather chip for a day, e.g. "☀️ 24°/13°" (with a ⚠️ on smoky days), or "" if none. */
function weatherChip(day: PlanDay): string {
  const w = day.weather;
  if (!w) return "";
  const hi = w.highC === null ? "—" : `${Math.round(w.highC)}°`;
  const lo = w.lowC === null ? "—" : `${Math.round(w.lowC)}°`;
  return `${w.emoji} ${hi}/${lo}${w.smoky ? " ⚠️" : ""}`;
}

/** What to show as a day's plan: its note (if skipped) or the chosen recipe. */
function planLabel(day: PlanDay): string {
  if (day.note) return `📝 ${day.note}`;
  return day.candidates[day.chosen]?.title ?? "—";
}

/**
 * Plain-text meal-plan card: one line per day (weekday + date, weather, chosen
 * recipe), plus a footer that reflects whether the plan is still a draft or has
 * been saved. Sent without a parse mode, so no escaping is needed.
 */
export function renderPlanCard(draft: PlanDraft): string {
  const lines = draft.days.map((day) => {
    const chip = weatherChip(day);
    return [dayLabel(day.date), chip, planLabel(day)].filter(Boolean).join("   ");
  });
  const footer = draft.committed
    ? "✅ Saved to Mealie."
    : "Tap 🔀 to swap a day or 🚫 to skip it, then ✅ Lock it in.";
  return `🍽️ Dinner plan\n\n${lines.join("\n")}\n\n${footer}`;
}

/**
 * Inline keyboard for a draft: one row per day, then an action row. A recipe day
 * gets a 🔀 shuffle button (only when it has alternatives) and a 🚫 skip button; a
 * skipped (note) day gets a ↩️ restore button when it still has recipes to fall
 * back to. The action row offers "shuffle all" (when any recipe day can shuffle)
 * and "lock it in". A committed draft gets no buttons.
 */
export function buildPlanKeyboard(draft: PlanDraft): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (draft.committed) return kb;

  let anyShufflable = false;
  draft.days.forEach((day, i) => {
    const wd = weekday(day.date);
    if (day.note) {
      // A skipped day: offer to restore it only if it has recipes to go back to.
      if (day.candidates.length > 0) kb.text(`↩️ ${wd}`, encodePlanCallback("unskip", draft.id, i)).row();
      return;
    }
    if (day.candidates.length > 1) {
      kb.text(`🔀 ${wd}`, encodePlanCallback("shuffle", draft.id, i));
      anyShufflable = true;
    }
    kb.text(`🚫 ${wd}`, encodePlanCallback("skip", draft.id, i)).row();
  });

  if (anyShufflable) kb.text("🔀 Shuffle all", encodePlanCallback("all", draft.id));
  kb.text("✅ Lock it in", encodePlanCallback("lock", draft.id));
  return kb;
}
