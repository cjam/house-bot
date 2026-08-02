/**
 * In-memory store of staged meal-plan "draft" cards. When the planner presents a
 * plan, it attaches a few candidate recipes per day; the card lets the user cycle
 * through them (shuffle) before committing the chosen ones to Mealie ("lock in").
 *
 * Drafts are ephemeral by design: they live only until locked (or the process
 * restarts). A button press on a card whose draft is gone degrades gracefully —
 * the callback handler just tells the user the plan is no longer active. Keeping
 * this in memory (rather than persisted like schedules/settings) matches that
 * short lifetime and keeps the card's fast path free of disk writes.
 */

/** One selectable recipe for a day; slug is optional (a plain title still works). */
export type PlanCandidate = { title: string; slug?: string };

/** Weather snapshot captured when the card is built, so re-renders stay pure. */
export type PlanWeather = { emoji: string; highC: number | null; lowC: number | null; smoky: boolean };

export type PlanDay = {
  /** Local calendar date, "YYYY-MM-DD". */
  date: string;
  /** Index of the currently selected candidate. */
  chosen: number;
  candidates: PlanCandidate[];
  weather?: PlanWeather;
  /**
   * When set, the day is a note/skip (e.g. "Eating out", "Pizza night") rather
   * than a recipe: it renders the note, hides shuffle, and — if it still has
   * candidates — offers to restore the recipe. Locking writes it as a plain note.
   */
  note?: string;
};

export type PlanDraft = {
  id: string;
  chatId: number;
  days: PlanDay[];
  /** True once the plan has been written to Mealie; the card then drops its buttons. */
  committed: boolean;
};

/** The day shape a caller supplies to `create` (chosen defaults to the first candidate). */
export type PlanDayInput = { date: string; candidates: PlanCandidate[]; weather?: PlanWeather; note?: string };

/** Default note applied by the card's skip button when the user doesn't type one. */
export const DEFAULT_SKIP_NOTE = "Eating out";

export type PlanStore = {
  create(chatId: number, days: PlanDayInput[]): PlanDraft;
  get(id: string): PlanDraft | undefined;
  /** Advance one day to its next candidate (wraps); returns the updated draft. */
  shuffle(id: string, dayIndex: number): PlanDraft | undefined;
  /** Advance every recipe day with more than one candidate (note days are left alone). */
  shuffleAll(id: string): PlanDraft | undefined;
  /** Turn a day into a note/skip; `note` defaults to DEFAULT_SKIP_NOTE. */
  skip(id: string, dayIndex: number, note?: string): PlanDraft | undefined;
  /** Clear a day's note, restoring it to a recipe day. */
  unskip(id: string, dayIndex: number): PlanDraft | undefined;
  /** Mark the draft committed (its recipes have been saved to Mealie). */
  commit(id: string): PlanDraft | undefined;
};

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

export function createPlanStore(): PlanStore {
  const drafts = new Map<string, PlanDraft>();

  return {
    create(chatId, days) {
      const draft: PlanDraft = {
        id: newId(),
        chatId,
        committed: false,
        days: days.map((d) => ({
          date: d.date,
          candidates: d.candidates,
          weather: d.weather,
          note: d.note,
          chosen: 0,
        })),
      };
      drafts.set(draft.id, draft);
      return draft;
    },

    get(id) {
      return drafts.get(id);
    },

    shuffle(id, dayIndex) {
      const draft = drafts.get(id);
      const day = draft?.days[dayIndex];
      if (!draft || !day) return undefined;
      if (day.candidates.length > 1) day.chosen = (day.chosen + 1) % day.candidates.length;
      return draft;
    },

    shuffleAll(id) {
      const draft = drafts.get(id);
      if (!draft) return undefined;
      for (const day of draft.days) {
        if (!day.note && day.candidates.length > 1) day.chosen = (day.chosen + 1) % day.candidates.length;
      }
      return draft;
    },

    skip(id, dayIndex, note) {
      const draft = drafts.get(id);
      const day = draft?.days[dayIndex];
      if (!draft || !day) return undefined;
      day.note = note?.trim() || DEFAULT_SKIP_NOTE;
      return draft;
    },

    unskip(id, dayIndex) {
      const draft = drafts.get(id);
      const day = draft?.days[dayIndex];
      if (!draft || !day) return undefined;
      delete day.note;
      return draft;
    },

    commit(id) {
      const draft = drafts.get(id);
      if (!draft) return undefined;
      draft.committed = true;
      return draft;
    },
  };
}
