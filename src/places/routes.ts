/**
 * GET /places/search — Nominatim-backed place autocomplete.
 *
 * The mobile app's search sheet calls this endpoint as the user types
 * "SM North", "Fairview", etc. We return a small list of matching
 * places with stable ids and lat/lng so the sheet can pin them and
 * then ask `/routes?nearOrigin=...&nearDest=...` for the actual route
 * candidates.
 *
 * Why proxy at all (vs. calling Nominatim directly from the app):
 *
 *   - Single contact UA per Nominatim's usage policy. The mobile app
 *     can't reliably set a meaningful User-Agent across iOS/Android
 *     fetch implementations, and we don't want a public bundle ID
 *     burning that UA across all our installs.
 *   - LRU cache. The same handful of landmark names ("SM North", "EDSA",
 *     "Cubao") will dominate traffic; a 24h cache means we hit the
 *     upstream once per day per popular query.
 *   - Per-route rate limit. Even with caching, a janky client could
 *     hammer this; Fastify's rate-limit plugin is on by opt-in.
 *   - Provider portability. If we move from public Nominatim to
 *     LocationIQ / self-hosted Photon, the wire format is identical
 *     and only `NOMINATIM_URL` changes.
 *
 * Cache key is the normalised query (lowercased + collapsed whitespace +
 * a `|<limit>` suffix). 24h TTL is fine because OSM places don't churn
 * meaningfully on that scale; if a popular landmark renames mid-day,
 * one extra day of stale results is a feature (it stops users from
 * seeing momentarily-empty geocoder pages while OSM editors fight
 * over the name tag).
 */

import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { LRUCache } from "../lib/lru-cache.js";
import { type NominatimResult, searchPlaces as nominatimSearch } from "./nominatim.js";

const PlaceResult = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  lat: z.number(),
  lng: z.number(),
  kind: z.string().optional(),
});

// Cap entries low — a single API process running this whole region
// realistically sees a few thousand unique queries per day post-launch
// and the Pareto curve is steep ("SM North", "Cubao", "EDSA"…).
// 500 entries × ~1 KB each = ~500 KB upper bound, trivial.
const CACHE_MAX = 500;
// 24h TTL: long enough that the cache absorbs the daily commuter
// spikes, short enough that an OSM-side rename propagates within a day.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type Searcher = typeof nominatimSearch;

export type PlacesRoutesDeps = {
  /** Override for tests so we don't hit the upstream. */
  search?: Searcher;
};

function normaliseQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

export function buildPlacesRoutes(deps: PlacesRoutesDeps = {}): FastifyPluginAsyncZod {
  const search: Searcher = deps.search ?? nominatimSearch;
  const cache = new LRUCache<string, NominatimResult[]>({
    max: CACHE_MAX,
    ttlMs: CACHE_TTL_MS,
  });

  const plugin: FastifyPluginAsyncZod = async (app) => {
    app.get(
      "/search",
      {
        schema: {
          tags: ["places"],
          querystring: z.object({
            // Single-letter queries are useless and wasteful; require
            // at least 2 characters so we don't burn upstream budget on
            // accidental keystrokes.
            q: z.string().min(2).max(120),
            limit: z.coerce.number().int().min(1).max(8).optional(),
          }),
          response: { 200: z.object({ items: z.array(PlaceResult) }) },
        },
        config: {
          // Deliberately tighter than the global default. The legitimate
          // typing pattern is debounced ~250ms in the app, so a real
          // user produces << 60 reqs/min even for a long query. Anything
          // above 60/min is almost certainly a wedged client or a
          // scraper, and the cache absorbs popular hot keys anyway.
          rateLimit: { max: 60, timeWindow: "1 minute" },
        },
      },
      async (req) => {
        const limit = req.query.limit ?? 8;
        const key = `${normaliseQuery(req.query.q)}|${limit}`;

        const cached = cache.get(key);
        if (cached) {
          return { items: cached };
        }

        // Bridge Fastify's `req.raw.on('close')` to an AbortSignal so a
        // cancelled client request doesn't keep the upstream socket
        // open. IncomingMessage doesn't expose a `signal` directly so
        // we wire one up by hand.
        const ac = new AbortController();
        const onClose = () => ac.abort();
        req.raw.once("close", onClose);

        let items: NominatimResult[];
        try {
          items = await search({ q: req.query.q, limit, signal: ac.signal });
        } catch (err) {
          // Don't 500 on upstream blips — the search sheet should be
          // able to render an "ulit" affordance, not a generic error
          // toast. We use 502 so monitoring can distinguish provider
          // outages from our own bugs.
          req.log.warn({ err, q: req.query.q }, "place search upstream failed");
          throw Object.assign(new Error("Geocoder upstream failed"), {
            statusCode: 502,
            code: "GEOCODER_UPSTREAM",
          });
        } finally {
          req.raw.off("close", onClose);
        }

        cache.set(key, items);
        return { items };
      },
    );
  };

  return plugin;
}

/** Default plugin used by the live server. Tests construct their own
 *  via `buildPlacesRoutes({ search })` to inject a mock provider. */
export const placesRoutes: FastifyPluginAsyncZod = buildPlacesRoutes();
