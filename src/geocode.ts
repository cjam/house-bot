/** Open-Meteo geocoding — free, keyless, and it also returns the IANA timezone. */
const GEO_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";

export type GeocodeResult = {
  /** Human-readable "City, Region, CC" label. */
  name: string;
  lat: number;
  long: number;
  /** IANA timezone for the place, when the API supplies one. */
  timezone?: string;
};

/**
 * Look up a place name, returning its coordinates, a readable label, and its
 * timezone — or null if nothing matched. Throws only on a transport/HTTP error.
 * Shared by the weather tool (coords) and the settings tools (coords + tz).
 */
export async function geocode(
  place: string,
  doFetch: typeof fetch = fetch,
): Promise<GeocodeResult | null> {
  const url = `${GEO_ENDPOINT}?name=${encodeURIComponent(place)}&count=1&language=en&format=json`;
  const res = await doFetch(url);
  if (!res.ok) throw new Error(`Geocoding returned HTTP ${res.status}.`);
  const data = (await res.json()) as { results?: any[] };
  const hit = data.results?.[0];
  if (!hit) return null;
  return {
    name: [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(", "),
    lat: hit.latitude,
    long: hit.longitude,
    timezone: hit.timezone,
  };
}
