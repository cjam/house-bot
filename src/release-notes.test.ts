import { describe, expect, test } from "bun:test";
import type { Release } from "./releases";
import {
  releasesToAnnounce,
  escapeMdV2,
  renderAnnouncement,
  plainAnnouncement,
  announceUpdates,
} from "./release-notes";

const rel = (version: string, over: Partial<Release> = {}): Release => ({
  version,
  title: `Release ${version}`,
  highlights: [`did ${version}`],
  ...over,
});

const list = [rel("0.3.0"), rel("0.2.0"), rel("0.1.0")]; // newest first

describe("releasesToAnnounce", () => {
  test("nothing when the latest is already announced", () => {
    expect(releasesToAnnounce(list, "0.3.0")).toEqual([]);
  });

  test("just the latest on a fresh install (no marker)", () => {
    expect(releasesToAnnounce(list, undefined)).toEqual([rel("0.3.0")]);
  });

  test("every release newer than the last-announced one, newest first", () => {
    expect(releasesToAnnounce(list, "0.1.0")).toEqual([rel("0.3.0"), rel("0.2.0")]);
  });

  test("just the latest when the marker predates the list", () => {
    expect(releasesToAnnounce(list, "0.0.1")).toEqual([rel("0.3.0")]);
  });

  test("nothing when there are no releases", () => {
    expect(releasesToAnnounce([], undefined)).toEqual([]);
  });
});

describe("escapeMdV2", () => {
  test("escapes MarkdownV2 special characters", () => {
    expect(escapeMdV2("a-b (c). !")).toBe("a\\-b \\(c\\)\\. \\!");
  });
});

describe("renderAnnouncement", () => {
  const r = rel("0.2.0", {
    title: "Meal-plan cards",
    highlights: ["Shuffle a day", "Skip with a note"],
    details: "Line one.\nLine two!",
  });

  test("has a header, escaped title + version, and bullet highlights", () => {
    const md = renderAnnouncement([r]);
    expect(md).toContain("🚀 *House bot was just updated*");
    expect(md).toContain("*Meal\\-plan cards* \\(v0\\.2\\.0\\)");
    expect(md).toContain("• Shuffle a day");
  });

  test("wraps details in an expandable blockquote (**> … ||) with escaped lines", () => {
    const md = renderAnnouncement([r]);
    expect(md).toContain("**>Line one\\.");
    expect(md).toContain(">Line two\\!||");
  });

  test("omits the collapsible section when a release has no details", () => {
    const md = renderAnnouncement([rel("0.1.0")]);
    expect(md).not.toContain("**>");
    expect(md).not.toContain("||");
  });
});

describe("plainAnnouncement", () => {
  test("is unescaped and includes highlights and details", () => {
    const text = plainAnnouncement([rel("0.2.0", { title: "Cards", details: "Some detail." })]);
    expect(text).toContain("Cards (v0.2.0)");
    expect(text).toContain("• did 0.2.0");
    expect(text).toContain("Some detail.");
    expect(text).not.toContain("\\");
  });
});

describe("announceUpdates", () => {
  test("sends to each chat and returns the version to persist", async () => {
    const sent: { chatId: number; md: string }[] = [];
    const version = await announceUpdates({
      releases: list,
      lastAnnounced: "0.2.0",
      chatIds: [1, 2],
      send: async (chatId, markdownV2) => {
        sent.push({ chatId, md: markdownV2 });
      },
    });
    expect(version).toBe("0.3.0");
    expect(sent.map((s) => s.chatId)).toEqual([1, 2]);
    expect(sent[0]!.md).toContain("Release 0\\.3\\.0");
  });

  test("sends nothing and returns undefined when up to date", async () => {
    let calls = 0;
    const version = await announceUpdates({
      releases: list,
      lastAnnounced: "0.3.0",
      chatIds: [1, 2],
      send: async () => {
        calls++;
      },
    });
    expect(version).toBeUndefined();
    expect(calls).toBe(0);
  });
});
