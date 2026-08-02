import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { geocode } from "./geocode";

/** Open-Meteo APIs — all free, documented, and keyless. */
const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const AIR_ENDPOINT = "https://air-quality-api.open-meteo.com/v1/air-quality";
const MAX_DAYS = 16;
/** Air quality forecasts only reach ~7 days; days beyond that get no AQI. */
const MAX_AQ_DAYS = 7;
/** Local hour we treat as "dinnertime" when summarizing hourly conditions. */
const DINNER_HOUR = 17;

const DAILY_FIELDS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "precipitation_probability_max",
  "precipitation_sum",
  "sunshine_duration",
  "wind_speed_10m_max",
  "sunrise",
  "sunset",
].join(",");

const HOURLY_FIELDS = ["temperature_2m", "precipitation_probability", "weather_code"].join(",");

/** WMO weather codes → short text (Open-Meteo returns the numeric code only). */
const WMO: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  56: "Light freezing drizzle",
  57: "Freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Rain showers",
  82: "Heavy rain showers",
  85: "Light snow showers",
  86: "Snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with heavy hail",
};

function describeCode(code: unknown): string | null {
  if (typeof code !== "number") return null;
  return WMO[code] ?? `Weather code ${code}`;
}

/** WMO code → a single weather emoji, for the compact meal-plan card. */
export function emojiForCode(code: number | null | undefined): string {
  if (typeof code !== "number") return "❓";
  if (code === 0) return "☀️";
  if (code === 1) return "🌤️";
  if (code === 2) return "⛅";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️"; // drizzle
  if (code >= 61 && code <= 67) return "🌧️"; // rain
  if (code >= 71 && code <= 77) return "🌨️"; // snow
  if (code >= 80 && code <= 82) return "🌧️"; // rain showers
  if (code === 85 || code === 86) return "🌨️"; // snow showers
  if (code >= 95) return "⛈️"; // thunderstorm
  return "❓";
}

function secondsToHours(seconds: unknown): number | null {
  return typeof seconds === "number" ? Math.round(seconds / 360) / 10 : null;
}

/** "2026-07-28T05:39" → "05:39"; anything else → null. */
function timeOfDay(iso: unknown): string | null {
  return typeof iso === "string" && iso.length >= 16 ? iso.slice(11, 16) : null;
}

/** US AQI band; wildfire smoke pushes this into the unhealthy ranges. */
function aqiCategory(aqi: number): string {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for sensitive groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very unhealthy";
  return "Hazardous";
}

type Coords = { lat: number; long: number; name?: string };
type Located = Coords | { error: string };

type WeatherDeps = {
  /** Home coordinates used when the caller passes neither `place` nor lat/long. */
  defaultLat: number;
  defaultLong: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Resolve a request's location: geocode `place` if given, else use explicit
 * lat/long, else fall back to the household's home coordinates.
 */
async function resolveLocation(
  args: { place?: string; lat?: number; long?: number },
  deps: WeatherDeps,
  doFetch: typeof fetch,
): Promise<Located> {
  if (args.place) {
    let hit;
    try {
      hit = await geocode(args.place, doFetch);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    if (!hit) return { error: `Couldn't find a location named "${args.place}".` };
    return { lat: hit.lat, long: hit.long, name: hit.name };
  }
  return { lat: args.lat ?? deps.defaultLat, long: args.long ?? deps.defaultLong };
}

/**
 * Fetch air quality and roll the hourly US AQI up to a per-day maximum (the
 * worst point of the day is what matters for "can we cook outside?"). Returns an
 * empty map on any failure — AQI enriches the forecast but never gates it.
 */
async function airMaxByDate(loc: Coords, days: number, doFetch: typeof fetch): Promise<Map<string, number>> {
  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.long),
    hourly: "us_aqi",
    timezone: "auto",
    forecast_days: String(Math.min(days, MAX_AQ_DAYS)),
  });
  const byDate = new Map<string, number>();
  const res = await doFetch(`${AIR_ENDPOINT}?${params}`);
  if (!res.ok) return byDate;
  const data = (await res.json()) as { hourly?: any };
  const times: string[] = data.hourly?.time ?? [];
  const aqis: unknown[] = data.hourly?.us_aqi ?? [];
  for (let i = 0; i < times.length; i++) {
    const date = times[i]!.slice(0, 10);
    const aqi = aqis[i];
    if (typeof aqi !== "number") continue;
    byDate.set(date, Math.max(byDate.get(date) ?? -Infinity, aqi));
  }
  return byDate;
}

/** One day of the combined forecast, trimmed to what meal planning needs. */
export type ForecastDay = {
  date: string | null;
  /** Raw WMO weather code, for emoji mapping in the meal-plan card. */
  code: number | null;
  summary: string | null;
  highC: number | null;
  lowC: number | null;
  /** Chance of precipitation, percent. */
  pop: number | null;
  rainMm: number | null;
  sunHours: number | null;
  sunrise: string | null;
  sunset: string | null;
  /** Conditions around dinnertime, from the hourly data. */
  dinner: { time: string; tempC: number | null; pop: number | null; summary: string | null } | null;
  /** Worst air quality of the day, or null when outside the AQI forecast range. */
  airQuality: { usAqi: number; category: string; smoky: boolean } | null;
};

/** Conditions at ~dinnertime on a given local date, from Open-Meteo's hourly arrays. */
function dinnerAt(hourly: any, date: string | null): ForecastDay["dinner"] {
  if (!date) return null;
  const key = `${date}T${String(DINNER_HOUR).padStart(2, "0")}:00`;
  const i = (hourly?.time as string[] | undefined)?.indexOf(key) ?? -1;
  if (i < 0) return null;
  return {
    time: `${String(DINNER_HOUR).padStart(2, "0")}:00`,
    tempC: hourly?.temperature_2m?.[i] ?? null,
    pop: hourly?.precipitation_probability?.[i] ?? null,
    summary: describeCode(hourly?.weather_code?.[i]),
  };
}

/** Merge Open-Meteo's daily/hourly forecast with per-day AQI into one array. */
function mapForecast(daily: any, hourly: any, aqiByDate: Map<string, number>, count: number): ForecastDay[] {
  const times: unknown[] = daily?.time ?? [];
  const days: ForecastDay[] = [];
  for (let i = 0; i < Math.min(times.length, count); i++) {
    const date = (times[i] as string) ?? null;
    const maxAqi = date === null ? undefined : aqiByDate.get(date);
    days.push({
      date,
      code: typeof daily?.weather_code?.[i] === "number" ? daily.weather_code[i] : null,
      summary: describeCode(daily?.weather_code?.[i]),
      highC: daily?.temperature_2m_max?.[i] ?? null,
      lowC: daily?.temperature_2m_min?.[i] ?? null,
      pop: daily?.precipitation_probability_max?.[i] ?? null,
      rainMm: daily?.precipitation_sum?.[i] ?? null,
      sunHours: secondsToHours(daily?.sunshine_duration?.[i]),
      sunrise: timeOfDay(daily?.sunrise?.[i]),
      sunset: timeOfDay(daily?.sunset?.[i]),
      dinner: dinnerAt(hourly, date),
      airQuality:
        maxAqi === undefined
          ? null
          : { usAqi: maxAqi, category: aqiCategory(maxAqi), smoky: maxAqi > 100 },
    });
  }
  return days;
}

type ForecastResult =
  | { ok: true; location: Coords; forecast: ForecastDay[] }
  | { ok: false; error: string };

/**
 * Fetch and stitch the daily/hourly forecast + air quality for resolved coords.
 * Shared by the `get_forecast` tool and the meal-plan card. Makes the forecast
 * and air-quality requests in parallel; AQI degrades to "none" on failure but
 * never gates the forecast.
 */
export async function fetchForecast(loc: Coords, count: number, doFetch: typeof fetch): Promise<ForecastResult> {
  // Air quality runs concurrently and degrades to "no AQI" on failure.
  const airPromise = airMaxByDate(loc, count, doFetch).catch(() => new Map<string, number>());

  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.long),
    daily: DAILY_FIELDS,
    hourly: HOURLY_FIELDS,
    timezone: "auto",
    forecast_days: String(count),
  });
  try {
    const res = await doFetch(`${FORECAST_ENDPOINT}?${params}`);
    if (!res.ok) return { ok: false, error: `Weather API returned HTTP ${res.status}.` };
    const data = (await res.json()) as { daily?: unknown; hourly?: unknown };
    const aqiByDate = await airPromise;
    return { ok: true, location: loc, forecast: mapForecast(data.daily, data.hourly, aqiByDate, count) };
  } catch (err) {
    return { ok: false, error: `Weather lookup failed: ${err instanceof Error ? err.message : err}` };
  }
}

/**
 * Fetch the forecast for the household's home coordinates, keyed by local date,
 * for the meal-plan card. Returns an empty map on any failure — the card renders
 * fine without weather, so a forecast hiccup never blocks presenting a plan.
 */
export async function forecastByDate(deps: {
  lat: number;
  long: number;
  days: number;
  fetchImpl?: typeof fetch;
}): Promise<Map<string, ForecastDay>> {
  const doFetch = deps.fetchImpl ?? fetch;
  const count = Math.min(Math.max(deps.days, 1), MAX_DAYS);
  const result = await fetchForecast({ lat: deps.lat, long: deps.long }, count, doFetch);
  const byDate = new Map<string, ForecastDay>();
  if (!result.ok) return byDate;
  for (const day of result.forecast) {
    if (day.date) byDate.set(day.date, day);
  }
  return byDate;
}

/**
 * A single `get_forecast` tool built on Open-Meteo (documented, keyless). It
 * makes two requests under the hood — the daily/hourly forecast and air quality
 * — in parallel and stitches them into one weekly forecast, each day carrying
 * conditions, high/low, chance of rain, hours of sun, sunrise/sunset, dinnertime
 * conditions, and air quality. Accepts a `place` name (geocoded) or explicit
 * lat/long, defaulting to the household's home. `timezone=auto` returns local
 * dates so the days line up with meal-plan days.
 */
export function createWeatherTool(deps: WeatherDeps): ToolSet {
  const doFetch = deps.fetchImpl ?? fetch;

  return {
    get_forecast: tool({
      description:
        "Get the daily weather forecast (with air quality) for meal planning. Defaults to the " +
        "household's home; pass a place name or lat/long to check elsewhere. Each day includes " +
        "conditions, high/low °C, chance of rain, hours of sun, sunrise/sunset, dinnertime " +
        "conditions, and air quality (a 'smoky' day favors indoor cooking over the BBQ).",
      inputSchema: z.object({
        place: z
          .string()
          .optional()
          .describe("Place name to look up, e.g. 'Tofino, BC'. Overrides lat/long when given."),
        lat: z.number().optional().describe("Latitude; defaults to the household's home."),
        long: z.number().optional().describe("Longitude; defaults to the household's home."),
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_DAYS)
          .optional()
          .describe(`How many days ahead (1-${MAX_DAYS}, default 7).`),
      }),
      execute: async ({ place, lat, long, days }) => {
        const loc = await resolveLocation({ place, lat, long }, deps, doFetch);
        if ("error" in loc) return { ok: false, error: loc.error };
        return fetchForecast(loc, days ?? 7, doFetch);
      },
    }),
  };
}
