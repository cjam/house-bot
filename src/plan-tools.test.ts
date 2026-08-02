import { describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import type { ToolSet } from "ai";
import { createPlanTools } from "./plan-tools";
import { createPlanStore } from "./plan-draft";

/** Fake forecast fetch: two days, one sunny (code 0), one rainy (code 61). */
const fetchImpl = (async (url: string) => {
  const isAir = url.includes("air-quality");
  const body = isAir
    ? { hourly: { time: [], us_aqi: [] } }
    : {
        daily: {
          time: ["2026-08-03", "2026-08-04"],
          weather_code: [0, 61],
          temperature_2m_max: [24, 18],
          temperature_2m_min: [13, 11],
          precipitation_probability_max: [0, 80],
          precipitation_sum: [0, 2],
          sunshine_duration: [36000, 3600],
          sunrise: ["2026-08-03T06:00", "2026-08-04T06:00"],
          sunset: ["2026-08-03T21:00", "2026-08-04T21:00"],
        },
        hourly: { time: [], temperature_2m: [], precipitation_probability: [], weather_code: [] },
      };
  return { ok: true, status: 200, json: async () => body } as Response;
}) as unknown as typeof fetch;

type Sent = { chatId: number; text: string; opts: any };

function setup() {
  const sent: Sent[] = [];
  const api = {
    sendMessage: async (chatId: number, text: string, opts: any) => {
      sent.push({ chatId, text, opts });
      return {} as never;
    },
  } as unknown as Api;
  const store = createPlanStore();
  const tools = createPlanTools({ api, chatId: 100, store, lat: 48.5, long: -123.4, fetchImpl });
  return { sent, store, tools };
}

const call = (t: ToolSet, args: unknown) =>
  (t.present_meal_plan!.execute as (a: unknown, o: unknown) => Promise<any>)(args, {
    toolCallId: "t",
    messages: [],
  });

describe("present_meal_plan", () => {
  test("sends an interactive card enriched with weather and stages the draft", async () => {
    const { sent, tools } = setup();
    const res = await call(tools, {
      days: [
        { date: "2026-08-03", options: [{ title: "Fajitas" }, { title: "Tacos" }] },
        { date: "2026-08-04", options: [{ title: "Curry" }] },
      ],
    });

    expect(res).toEqual({ ok: true, presented: 2 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(100);
    expect(sent[0]!.text).toContain("Fajitas");
    expect(sent[0]!.text).toContain("☀️ 24°/13°"); // sunny day
    expect(sent[0]!.text).toContain("🌧️ 18°/11°"); // rainy day
    expect(sent[0]!.opts.reply_markup).toBeDefined();
  });

  test("accepts a note day (no options) and renders it as skipped", async () => {
    const { sent, tools } = setup();
    const res = await call(tools, {
      days: [
        { date: "2026-08-03", options: [{ title: "Fajitas" }] },
        { date: "2026-08-04", note: "Pizza night" },
      ],
    });
    expect(res).toEqual({ ok: true, presented: 2 });
    expect(sent[0]!.text).toContain("📝 Pizza night");
  });

  test("still presents the card when the forecast is unavailable", async () => {
    const sent: Sent[] = [];
    const api = {
      sendMessage: async (chatId: number, text: string, opts: any) => {
        sent.push({ chatId, text, opts });
        return {} as never;
      },
    } as unknown as Api;
    const failing = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const tools = createPlanTools({
      api,
      chatId: 100,
      store: createPlanStore(),
      lat: 48.5,
      long: -123.4,
      fetchImpl: failing,
    });
    const res = await call(tools, { days: [{ date: "2026-08-03", options: [{ title: "Fajitas" }] }] });
    expect(res.ok).toBe(true);
    expect(sent[0]!.text).toContain("Fajitas");
  });
});
