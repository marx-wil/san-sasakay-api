/**
 * Nominatim-compatible place search.
 *
 * Talks to the configured upstream (`NOMINATIM_URL` — public Nominatim
 * by default, swappable for LocationIQ / Mapbox-Geocoder / a self-hosted
 * Photon mirror). The wire format is the canonical Nominatim
 * `/search?format=json&...` response, which all of those serve.
 *
 * Why a thin abstraction:
 *
 *   - Keeps the route handler (`src/places/routes.ts`) provider-agnostic.
 *     Swapping the upstream becomes "set a different URL" — no route or
 *     client changes.
 *   - Centralises the User-Agent contract Nominatim's usage policy
 *     requires. Public Nominatim *will* block a bare `node-fetch` UA on
 *     any volume, so the header is non-negotiable.
 *   - Centralises the Metro Manila viewbox + countrycodes filters so
 *     every caller gets results bounded to "places a Filipino commuter
 *     could plausibly be heading to".
 *
 * Out of scope here: caching (lives in `routes.ts` so the same cache
 * survives provider swaps) and rate limiting (also in `routes.ts` via
 * Fastify's per-route rate-limit config).
 */

import { env } from "../config.js";
import { logger } from "../lib/logger.js";

// Metro Manila bounding box: ~120.90°E,14.40°N → ~121.15°E,14.80°N.
// `viewbox` order in Nominatim is left,top,right,bottom (i.e. west,
// north, east, south), and `bounded=1` makes the filter strict.
// Loose enough to include CALABARZON edge cases like Antipolo or
// Bacoor that commuters routinely treat as part of "Manila", tight
// enough that "Manila" the noun never matches Manila, Arkansas.
const VIEWBOX = "120.90,14.80,121.15,14.40" as const;

export type NominatimResult = {
  /** osm_type+osm_id as a stable id ("N1234567" / "W890" / "R42"). */
  id: string;
  /** Short label — first comma chunk of `display_name`, useful for chips/cards. */
  name: string;
  /** Full Nominatim display_name, kept verbatim for the secondary subtitle. */
  displayName: string;
  lat: number;
  lng: number;
  /** OSM class/type passthrough ("amenity", "shop"…). Lets clients filter. */
  kind?: string;
};

type NominatimSearchRow = {
  osm_id?: number | string;
  osm_type?: string;
  display_name?: string;
  lat?: string;
  lon?: string;
  class?: string;
  type?: string;
};

export type SearchOptions = {
  q: string;
  /** Hard upper bound (Nominatim's own hard cap is 50; we cap at 8 for UX). */
  limit?: number;
  /** AbortController forwarded from the request so a cancelled user
   *  search doesn't keep the upstream socket alive. */
  signal?: AbortSignal;
};

/**
 * Build the User-Agent we send to the upstream. Nominatim's usage
 * policy explicitly requires a meaningful UA with contact info; LocationIQ
 * and most paid drop-ins also log it. Doing this once at module load
 * means the route handler never has to think about it.
 */
function userAgent(): string {
  const base = env.NOMINATIM_USER_AGENT;
  const contact = env.NOMINATIM_CONTACT_EMAIL;
  if (contact && !base.includes(contact)) {
    return `${base} (${contact})`;
  }
  return base;
}

const UA = userAgent();

/**
 * Issue a place-search query against the configured Nominatim provider.
 * Returns at most `limit` results (default 8), bounded to Metro Manila.
 * Throws on transport / non-2xx errors so the caller can surface a 502.
 */
export async function searchPlaces(opts: SearchOptions): Promise<NominatimResult[]> {
  const limit = Math.min(Math.max(opts.limit ?? 8, 1), 12);
  const url = new URL("/search", env.NOMINATIM_URL);
  url.searchParams.set("q", opts.q);
  url.searchParams.set("format", "json");
  url.searchParams.set("countrycodes", "ph");
  url.searchParams.set("viewbox", VIEWBOX);
  url.searchParams.set("bounded", "1");
  // We don't render the structured address breakdown today — keep the
  // payload minimal so the upstream returns sooner.
  url.searchParams.set("addressdetails", "0");
  url.searchParams.set("limit", String(limit));
  // Accept-Language Tagalog-first with an English fallback. Nominatim
  // honours this for `display_name` localisation where translations exist.
  url.searchParams.set("accept-language", "tl,en");

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
    },
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, q: opts.q, body: body.slice(0, 200) }, "nominatim non-2xx");
    throw new Error(`upstream ${res.status}`);
  }

  const json = (await res.json()) as NominatimSearchRow[];
  if (!Array.isArray(json)) return [];

  const out: NominatimResult[] = [];
  for (const row of json) {
    const lat = typeof row.lat === "string" ? Number(row.lat) : Number.NaN;
    const lng = typeof row.lon === "string" ? Number(row.lon) : Number.NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const display = typeof row.display_name === "string" ? row.display_name : "";
    if (!display) continue;
    // Stable id: "N12345" / "W12345" / "R12345" — first letter of
    // osm_type, then osm_id. Falls back to a coordinate string when
    // the upstream omits one (some self-hosted Photon mirrors do).
    const osmType = typeof row.osm_type === "string" ? row.osm_type[0] : "?";
    const osmId =
      typeof row.osm_id === "number" || typeof row.osm_id === "string"
        ? String(row.osm_id)
        : `${lat.toFixed(5)}_${lng.toFixed(5)}`;
    const id = `${osmType}${osmId}`;
    // Short label = first comma chunk; commuters scan that, not the
    // 60-char display_name suffix ("..., Quezon City, Metro Manila, ...").
    const name = display.split(",", 1)[0]?.trim() || display;
    const kind = row.class || row.type || undefined;
    out.push({ id, name, displayName: display, lat, lng, kind });
  }
  return out;
}
