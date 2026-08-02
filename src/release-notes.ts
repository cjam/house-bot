import type { Release } from "./releases";

/**
 * Which releases to announce on this startup, newest first. Nothing to announce
 * on an ordinary restart (version unchanged). A fresh install (no marker yet)
 * announces just the latest — not the whole back catalogue. Otherwise announce
 * every release newer than the last-announced one (or just the latest if that
 * marker predates the list).
 */
export function releasesToAnnounce(all: Release[], lastAnnounced: string | undefined): Release[] {
  const latest = all[0];
  if (!latest) return [];
  if (lastAnnounced === latest.version) return [];
  if (lastAnnounced === undefined) return [latest];
  const idx = all.findIndex((r) => r.version === lastAnnounced);
  return idx === -1 ? [latest] : all.slice(0, idx);
}

/** Characters MarkdownV2 treats as syntax outside an entity; all must be escaped. */
const MDV2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escape arbitrary text for Telegram MarkdownV2. */
export function escapeMdV2(text: string): string {
  return text.replace(MDV2_SPECIAL, (c) => `\\${c}`);
}

/**
 * Render prose as a Telegram *expandable* (collapsible) blockquote: the block
 * starts with `**>`, every line is prefixed with `>`, and the whole quote ends
 * with `||` — the mark that makes it collapsed-by-default with a "show more".
 */
function expandableQuote(text: string): string {
  const lines = text.split("\n");
  const body = lines.map((line, i) => `${i === 0 ? "**>" : ">"}${escapeMdV2(line)}`).join("\n");
  return `${body}||`;
}

/**
 * Build the "I've been updated" message in MarkdownV2: a header, then each
 * release's title + version, its highlight bullets (shown expanded), and — if it
 * has any — its details in a collapsible section.
 */
export function renderAnnouncement(releases: Release[]): string {
  const blocks = releases.map((r) => {
    const title = `*${escapeMdV2(r.title)}* \\(v${escapeMdV2(r.version)}\\)`;
    const bullets = r.highlights.map((h) => `• ${escapeMdV2(h)}`).join("\n");
    const details = r.details ? `\n${expandableQuote(r.details)}` : "";
    return `${title}\n${bullets}${details}`;
  });
  return ["🚀 *House bot was just updated*", ...blocks].join("\n\n");
}

/** Plain-text fallback for clients/entities Telegram rejects — no markup. */
export function plainAnnouncement(releases: Release[]): string {
  const blocks = releases.map((r) => {
    const bullets = r.highlights.map((h) => `• ${h}`).join("\n");
    const details = r.details ? `\n\n${r.details}` : "";
    return `${r.title} (v${r.version})\n${bullets}${details}`;
  });
  return ["🚀 House bot was just updated", ...blocks].join("\n\n");
}

/**
 * Announce any newer releases to each chat, then report the version to persist
 * (undefined = nothing to announce, don't touch the marker). `send` is given both
 * the MarkdownV2 and a plain fallback so the caller can retry plain if Telegram
 * rejects the formatting. Best-effort per chat is the caller's concern.
 */
export async function announceUpdates(opts: {
  releases: Release[];
  lastAnnounced: string | undefined;
  chatIds: Iterable<number>;
  send: (chatId: number, markdownV2: string, plain: string) => Promise<void>;
}): Promise<string | undefined> {
  const toAnnounce = releasesToAnnounce(opts.releases, opts.lastAnnounced);
  if (toAnnounce.length === 0) return undefined;
  const markdownV2 = renderAnnouncement(toAnnounce);
  const plain = plainAnnouncement(toAnnounce);
  for (const chatId of opts.chatIds) {
    await opts.send(chatId, markdownV2, plain);
  }
  return opts.releases[0]?.version;
}
