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
  test("persists the version BEFORE sending, and returns what it announced", async () => {
    const order: string[] = [];
    const announced = await announceUpdates({
      releases: list,
      lastAnnounced: "0.2.0",
      chatIds: [1, 2],
      persist: async (v) => {
        order.push(`persist:${v}`);
      },
      send: async (chatId, markdownV2) => {
        order.push(`send:${chatId}`);
        expect(markdownV2).toContain("Release 0\\.3\\.0");
      },
    });
    expect(announced.map((r) => r.version)).toEqual(["0.3.0"]);
    // Marker is written first so a failed/interrupted send can't cause a repeat.
    expect(order).toEqual(["persist:0.3.0", "send:1", "send:2"]);
  });

  test("does nothing (no persist, no send) when up to date", async () => {
    let persists = 0;
    let sends = 0;
    const announced = await announceUpdates({
      releases: list,
      lastAnnounced: "0.3.0",
      chatIds: [1, 2],
      persist: async () => {
        persists++;
      },
      send: async () => {
        sends++;
      },
    });
    expect(announced).toEqual([]);
    expect(persists).toBe(0);
    expect(sends).toBe(0);
  });
});
