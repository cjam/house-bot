/**
 * Human-authored release notes, newest first. The top entry's `version` is the
 * bot's current version; on startup it's compared against the last-announced
 * version (persisted in the data volume) and any newer releases are posted to the
 * allowed chats. See [`release-notes.ts`](release-notes.ts) for the logic and
 * [`deploy-state.ts`](deploy-state.ts) for the persisted marker.
 *
 * To announce a deploy: add a new entry at the TOP with a fresh `version`. Keep
 * `highlights` short (they show expanded); put longer prose in `details` (shown
 * in a collapsible section). `version` is just a unique, ordered id — bump it
 * however you like (semver here), it only needs to differ from the last one.
 */
export type Release = {
  /** Unique, ordered id; also the dedupe key for "already announced". */
  version: string;
  /** Short headline for the release. */
  title: string;
  /** A few short bullets — the new capabilities, shown expanded. */
  highlights: string[];
  /** Optional longer prose, shown in a collapsible (expandable) section. */
  details?: string;
};

export const RELEASES: Release[] = [
  {
    version: "0.2.0",
    title: "Interactive meal-plan cards",
    highlights: [
      "/plan posts an interactive dinner-plan card — weather plus a recipe per day",
      "Shuffle any day (or all days) through alternates instantly",
      "Skip a day with a note (eating out, pizza night), then lock it in to save to Mealie",
      "Choose how many days to plan with /setdays (default 5)",
    ],
    details:
      "Ask me to “plan our dinners” or run /plan. Each day shows the forecast (with a warning on " +
      "smoky days) and a picked recipe. Tap the shuffle button to swap a day, the skip button to " +
      "leave a note (or just tell me “Friday is pizza night”), then Lock it in — chosen recipes are " +
      "written to Mealie and skipped days become notes. Set the planning window per chat with " +
      "/setdays 1–14.",
  },
];
