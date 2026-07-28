import { describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import { createWeatherTool } from "./weather";

// Open-Meteo returns column-oriented arrays under `daily` / `hourly`.
const FORECAST = {
  daily: {
    time: ["2026-07-28", "2026-07-29"],
    weather_code: [2, 80],
    temperature_2m_max: [22, 18],
    temperature_2m_min: [12, 11],
    precipitation_probability_max: [20, 70],
    precipitation_sum: [0, 1.1],
    sunshine_duration: [18000, 18000], // seconds → 5.0 hours
    wind_speed_10m_max: [13, 20],
    sunrise: ["2026-07-28T05:39", "2026-07-29T05:41"],
    sunset: ["2026-07-28T21:07", "2026-07-29T21:05"],
  },
  hourly: {
    time: ["2026-07-28T17:00", "2026-07-29T17:00"],
    temperature_2m: [20, 17],
    precipitation_probability: [15, 60],
    weather_code: [2, 80],
  },
};

const GEO = {
  results: [
    { name: "Tofino", admin1: "British Columbia", country_code: "CA", latitude: 49.153, longitude: -125.906 },
  ],
};

const AIR = {
  hourly: {
    time: ["2026-07-28T00:00", "2026-07-28T12:00", "2026-07-29T00:00"],
    us_aqi: [40, 120, 55],
  },
};

type Capture = { urls: string[] };

/** Fake fetch that routes by URL; `failAir` fails only the air-quality call. */
function routingFetch(capture: Capture, opts: { ok?: boolean; failAir?: boolean } = {}): typeof fetch {
  const { ok = true, failAir = false } = opts;
  return (async (url: string) => {
    capture.urls.push(url);
    const isAir = url.includes("air-quality");
    const body = url.includes("geocoding-api") ? GEO : isAir ? AIR : FORECAST;
    const good = ok && !(isAir && failAir);
    return { ok: good, status: good ? 200 : 500, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

const tools = (fetchImpl: typeof fetch): ToolSet =>
  createWeatherTool({ defaultLat: 48.496, defaultLong: -123.393, fetchImpl });

const call = (t: ToolSet, args: unknown) =>
  (t.get_forecast!.execute as (a: unknown, o: unknown) => Promise<any>)(args, {
    toolCallId: "t",
    messages: [],
  });

describe("get_forecast", () => {
  test("combines forecast + air quality into one day with all fields", async () => {
    const cap: Capture = { urls: [] };
    const res = await call(tools(routingFetch(cap)), {});
    expect(res.ok).toBe(true);
    // Two upstream calls: forecast and air quality.
    expect(cap.urls.some((u) => u.includes("/v1/forecast"))).toBe(true);
    expect(cap.urls.some((u) => u.includes("air-quality"))).toBe(true);
    expect(res.forecast[0]).toEqual({
      date: "2026-07-28",
      summary: "Partly cloudy", // WMO code 2
      highC: 22,
      lowC: 12,
      pop: 20,
      rainMm: 0,
      sunHours: 5, // 18000s / 3600
      sunrise: "05:39",
      sunset: "21:07",
      dinner: { time: "17:00", tempC: 20, pop: 15, summary: "Partly cloudy" },
      airQuality: { usAqi: 120, category: "Unhealthy for sensitive groups", smoky: true },
    });
    expect(res.forecast[1].airQuality).toEqual({ usAqi: 55, category: "Moderate", smoky: false });
  });

  test("geocodes a place name and reports the resolved location", async () => {
    const cap: Capture = { urls: [] };
    const res = await call(tools(routingFetch(cap)), { place: "Tofino" });
    expect(cap.urls[0]).toContain("geocoding-api");
    expect(cap.urls[0]).toContain("name=Tofino");
    expect(cap.urls.some((u) => u.includes("/v1/forecast") && u.includes("latitude=49.153"))).toBe(true);
    expect(res.location).toEqual({ lat: 49.153, long: -125.906, name: "Tofino, British Columbia, CA" });
  });

  test("still returns the forecast (airQuality null) when air quality fails", async () => {
    const cap: Capture = { urls: [] };
    const res = await call(tools(routingFetch(cap, { failAir: true })), {});
    expect(res.ok).toBe(true);
    expect(res.forecast[0].airQuality).toBeNull();
    expect(res.forecast[0].highC).toBe(22); // weather is unaffected
  });

  test("passes through ad-hoc lat/long and day count", async () => {
    const cap: Capture = { urls: [] };
    await call(tools(routingFetch(cap)), { lat: 49.28, long: -123.12, days: 3 });
    expect(cap.urls.some((u) => u.includes("/v1/forecast") && u.includes("forecast_days=3"))).toBe(true);
  });

  test("reports a place it can't find without fetching the forecast", async () => {
    const emptyGeo = (async () =>
      ({ ok: true, status: 200, json: async () => ({ results: [] }) }) as Response) as unknown as typeof fetch;
    const res = await call(tools(emptyGeo), { place: "Nowheresville" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Couldn't find");
  });

  test("reports a forecast HTTP error instead of throwing", async () => {
    const cap: Capture = { urls: [] };
    const res = await call(tools(routingFetch(cap, { ok: false })), {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("500");
  });

  test("catches a fetch failure", async () => {
    const boom = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await call(tools(boom), {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("network down");
  });
});
