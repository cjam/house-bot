import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { Api } from "grammy";
import { forecastByDate, emojiForCode } from "./weather";
import { renderPlanCard, buildPlanKeyboard } from "./meal-plan-ui";
import type { PlanDayInput, PlanStore } from "./plan-draft";

type PlanToolsDeps = {
  /** Bot API, used to send the card message to the chat. */
  api: Api;
  chatId: number;
  store: PlanStore;
  /** Home coordinates for the per-day weather chips. */
  lat: number;
  long: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/** How many forecast days to request to cover the planned dates. */
function forecastSpan(dates: string[]): number {
  const today = new Date().toISOString().slice(0, 10);
  const latest = [...dates].sort().at(-1) ?? today;
  const ahead = Math.round((Date.parse(`${latest}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) + 1;
  return Math.min(16, Math.max(dates.length, ahead, 1));
}

/**
 * Exposes a `present_meal_plan` tool to the planner. The model calls it once it
 * has settled on the week's dinners; the bot enriches each day with the home
 * weather forecast, sends an interactive card (weather + recipe per day, with
 * shuffle/lock buttons), and stages the draft so the buttons can act on it. The
 * plan isn't written to Mealie until the user taps "Lock it in".
 */
export function createPlanTools(deps: PlanToolsDeps): ToolSet {
  return {
    present_meal_plan: tool({
      description:
        "Show the user an interactive dinner-plan card (one row per day: weather + the chosen " +
        "recipe, with buttons to shuffle each day, skip it, or lock the plan in). Call this once " +
        "you've picked recipes for the days being planned. Give a few candidate recipes per day — " +
        "the first is the initial pick, the rest are shuffle alternatives. For a day the household " +
        "isn't cooking (eating out, pizza night, leftovers), set 'note' instead of options and it " +
        "shows as a skipped day. The plan is NOT saved to Mealie until the user locks it in, so " +
        "don't write the meal plan yourself first. After calling this, reply with just a one-line " +
        "intro; the card shows the details.",
      inputSchema: z.object({
        days: z
          .array(
            z
              .object({
                date: z.string().describe("The day being planned, as YYYY-MM-DD."),
                options: z
                  .array(
                    z.object({
                      title: z.string().describe("Recipe title as it appears in Mealie."),
                      slug: z.string().optional().describe("Mealie recipe slug, if known."),
                    }),
                  )
                  .optional()
                  .describe("Candidate recipes; the first is the initial pick, the rest are alternatives."),
                note: z
                  .string()
                  .optional()
                  .describe("A note for a day with no cooking, e.g. 'Eating out' or 'Pizza night'. Use instead of options."),
              })
              .refine((d) => (d.options && d.options.length > 0) || d.note, {
                message: "each day needs either options or a note",
              }),
          )
          .min(1)
          .describe("One entry per day to plan, in order."),
      }),
      execute: async ({ days }) => {
        const weather = await forecastByDate({
          lat: deps.lat,
          long: deps.long,
          days: forecastSpan(days.map((d) => d.date)),
          fetchImpl: deps.fetchImpl,
        });

        const dayInputs: PlanDayInput[] = days.map((d) => {
          const f = weather.get(d.date);
          return {
            date: d.date,
            candidates: d.options ?? [],
            note: d.note,
            weather: f
              ? { emoji: emojiForCode(f.code), highC: f.highC, lowC: f.lowC, smoky: f.airQuality?.smoky ?? false }
              : undefined,
          };
        });

        const draft = deps.store.create(deps.chatId, dayInputs);
        await deps.api.sendMessage(deps.chatId, renderPlanCard(draft), {
          reply_markup: buildPlanKeyboard(draft),
        });
        return { ok: true, presented: draft.days.length };
      },
    }),
  };
}
