/**
 * Integration test for GET /places/search.
 *
 * We build a Fastify app with the `placesRoutes` plugin pointed at a
 * mocked Nominatim provider so the test never touches the upstream and
 * never needs network. `app.inject()` runs the request through the full
 * Fastify pipeline (zod validation, error handler, plugin) so
 * assertions cover the wire shape, not just the handler internals.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import {
  type ZodTypeProvider,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { AppError } from "../lib/errors.js";
import type { NominatimResult, SearchOptions } from "./nominatim.js";
import { buildPlacesRoutes } from "./routes.js";

type MockSearch = (opts: SearchOptions) => Promise<NominatimResult[]>;

function buildApp(search: MockSearch) {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Mirror server.ts's error handler so non-2xx surfaces map to the
  // wire shape the client actually sees.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      reply
        .status(err.statusCode)
        .send({ error: err.code, message: err.message, details: err.details });
      return;
    }
    const fe = err as { validation?: unknown; statusCode?: number; code?: string };
    if (fe.validation) {
      reply.status(400).send({ error: "VALIDATION_ERROR", message: "Request validation failed" });
      return;
    }
    if (fe.statusCode && fe.statusCode < 600) {
      reply
        .status(fe.statusCode)
        .send({ error: fe.code ?? "BAD_REQUEST", message: (err as Error).message });
      return;
    }
    reply.status(500).send({ error: "INTERNAL_ERROR", message: "Unexpected" });
  });
  app.register(buildPlacesRoutes({ search }), { prefix: "/places" });
  return app;
}

const FAKE_RESULTS: NominatimResult[] = [
  {
    id: "N123",
    name: "SM City North EDSA",
    displayName: "SM City North EDSA, North Avenue, Quezon City, Metro Manila, Philippines",
    lat: 14.6566,
    lng: 121.0287,
    kind: "shop",
  },
];

test("GET /places/search returns proxied results", async () => {
  const app = buildApp(async () => FAKE_RESULTS);
  const res = await app.inject({ method: "GET", url: "/places/search?q=SM%20North" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { items: NominatimResult[] };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0]?.id, "N123");
  assert.equal(body.items[0]?.name, "SM City North EDSA");
  await app.close();
});

test("GET /places/search 400s on too-short queries", async () => {
  const app = buildApp(async () => FAKE_RESULTS);
  const res = await app.inject({ method: "GET", url: "/places/search?q=a" });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test("GET /places/search caches identical queries", async () => {
  let calls = 0;
  const app = buildApp(async () => {
    calls += 1;
    return FAKE_RESULTS;
  });
  await app.inject({ method: "GET", url: "/places/search?q=cubao" });
  await app.inject({ method: "GET", url: "/places/search?q=cubao" });
  // Same trimmed/lowercased key — second call should be served from cache.
  await app.inject({ method: "GET", url: "/places/search?q=CUBAO" });
  await app.inject({ method: "GET", url: "/places/search?q=%20cubao%20" });
  assert.equal(calls, 1, "cache must collapse case/whitespace variants");
  await app.close();
});

test("GET /places/search differentiates limits in the cache key", async () => {
  let calls = 0;
  const app = buildApp(async () => {
    calls += 1;
    return FAKE_RESULTS;
  });
  await app.inject({ method: "GET", url: "/places/search?q=fairview&limit=3" });
  await app.inject({ method: "GET", url: "/places/search?q=fairview&limit=8" });
  assert.equal(calls, 2, "different limits should bypass each other's cache");
  await app.close();
});

test("GET /places/search returns 502 when upstream throws", async () => {
  const app = buildApp(async () => {
    throw new Error("boom");
  });
  const res = await app.inject({ method: "GET", url: "/places/search?q=quiapo" });
  assert.equal(res.statusCode, 502);
  const body = res.json() as { error?: string };
  assert.equal(body.error, "GEOCODER_UPSTREAM");
  await app.close();
});
