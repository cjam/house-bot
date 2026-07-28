import { describe, expect, test } from "bun:test";
import { geocode } from "./geocode";

function fakeFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response) as unknown as typeof fetch;
}

describe("geocode", () => {
  test("maps the first result to name/lat/long/timezone", async () => {
    const fetchImpl = fakeFetch({
      results: [
        {
          name: "Nanaimo",
          admin1: "British Columbia",
          country_code: "CA",
          latitude: 49.16,
          longitude: -123.94,
          timezone: "America/Vancouver",
        },
      ],
    });
    expect(await geocode("Nanaimo", fetchImpl)).toEqual({
      name: "Nanaimo, British Columbia, CA",
      lat: 49.16,
      long: -123.94,
      timezone: "America/Vancouver",
    });
  });

  test("returns null when there are no matches", async () => {
    expect(await geocode("Nowheresville", fakeFetch({ results: [] }))).toBeNull();
  });

  test("throws on an HTTP error", async () => {
    await expect(geocode("Nanaimo", fakeFetch({}, false))).rejects.toThrow("HTTP 500");
  });
});
