/**
 * Dev seed for `reports` + `trip_feedback`.
 *
 * Separate from `seed.ts` (a pure OSM route import) because this manufactures
 * fake users and fake observations. Its job is to make every branch of the
 * route report summary reachable in a local build without tapping through the
 * report flow dozens of times.
 *
 * Each target route gets one named scenario (see SCENARIOS below) so there is
 * a specific route to open for "contested", "incident", "stale", and so on.
 * The script prints route code → expected outcome at the end; treat that as
 * the answer key when checking the sheet.
 *
 * Ages are baked into created_at at insert time, so a plain re-run leaves the
 * data ageing out of the freshness window. `--reset` (the normal workflow)
 * deletes everything this script owns and reinserts, re-basing every age to
 * now.
 *
 * Usage:
 *   npm run db:seed                          # routes first, if not seeded
 *   npm run db:seed:reports -- --reset       # re-base ages to now
 *   npm run db:seed:reports -- --routes=JEEP-101,UV-300
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { env } from "../config.js";
import { logger } from "../lib/logger.js";
import { runAggregatorOnce } from "../workers/aggregator.js";
import { db, pool } from "./client.js";
import type { PassengerLevel, ReportStatus, TripIssue, TripSpeed } from "./schema.js";

// ─── Safety ──────────────────────────────────────────────────────────────────

/**
 * This script writes fake users and fake reports. Pointing it at a shared or
 * production database would poison the aggregate everyone else reads, so
 * refuse anything that isn't demonstrably local.
 */
function assertLocalDatabase(): void {
  if (env.NODE_ENV === "production") {
    throw new Error("refusing to seed reports with NODE_ENV=production");
  }

  let host: string;
  try {
    host = new URL(env.DATABASE_URL).hostname;
  } catch {
    throw new Error("could not parse DATABASE_URL to verify it is local");
  }

  const localHosts = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    "postgres",
    "db",
    "host.docker.internal",
  ]);
  const isLocal = localHosts.has(host) || host.endsWith(".local") || host.endsWith(".internal");
  if (!isLocal) {
    throw new Error(
      `refusing to seed fake reports against non-local host "${host}". Set DATABASE_URL to a local database first.`,
    );
  }
}

// ─── Synthetic reporters ─────────────────────────────────────────────────────

/** Deterministic UUID v4-shaped id from a stable label. */
function seededUuid(label: string): string {
  const h = createHash("sha256").update(`sansasakay-seed:${label}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Credibility scores are deliberately spread rather than all 1.0. With uniform
 * weights, a weighted share is indistinguishable from a raw count share, which
 * would let a broken weighting term pass verification unnoticed.
 */
const REPORTERS = [
  { label: "seed-reporter-01", credibility: 0.5 },
  { label: "seed-reporter-02", credibility: 0.7 },
  { label: "seed-reporter-03", credibility: 0.9 },
  { label: "seed-reporter-04", credibility: 1.0 },
  { label: "seed-reporter-05", credibility: 1.0 },
  { label: "seed-reporter-06", credibility: 1.2 },
  { label: "seed-reporter-07", credibility: 1.4 },
  { label: "seed-reporter-08", credibility: 1.6 },
  { label: "seed-reporter-09", credibility: 1.8 },
  { label: "seed-reporter-10", credibility: 2.0 },
].map((r, i) => ({ ...r, id: seededUuid(r.label), index: i }));

const REPORTER_IDS = REPORTERS.map((r) => r.id);

// ─── Scenarios ───────────────────────────────────────────────────────────────

type StatusReport = { status: ReportStatus; ageMin: number };

type Feedback = {
  tripIssue: TripIssue;
  tripSpeed: TripSpeed;
  passengerLevel: PassengerLevel;
  ageMin: number;
};

type Scenario = {
  key: string;
  /** What to expect in the sheet once seeded — printed as the answer key. */
  expect: string;
  reports: StatusReport[];
  feedback: Feedback[];
};

/** Compact builder: n reports of one status spread across an age range. */
function spread(status: ReportStatus, n: number, fromMin: number, toMin: number): StatusReport[] {
  if (n === 1) return [{ status, ageMin: fromMin }];
  const step = (toMin - fromMin) / (n - 1);
  return Array.from({ length: n }, (_, i) => ({
    status,
    ageMin: Math.round((fromMin + step * i) * 10) / 10,
  }));
}

const SCENARIOS: Scenario[] = [
  {
    key: "high-confidence",
    expect: "One dominant Mabilis bar, confidence near 1.0, crowd Kaunti",
    reports: [...spread("tumatakbo", 7, 1, 9), ...spread("limitado", 1, 6, 6)],
    feedback: [
      { tripIssue: "tuloy_tuloy", tripSpeed: "mabilis", passengerLevel: "kaunti", ageMin: 3 },
      { tripIssue: "tuloy_tuloy", tripSpeed: "mabilis", passengerLevel: "kaunti", ageMin: 7 },
      { tripIssue: "okay_lang", tripSpeed: "mabilis", passengerLevel: "sakto", ageMin: 11 },
    ],
  },
  {
    key: "contested",
    expect: "Three visible bars (4/3/3), low confidence — the case the badge alone cannot express",
    reports: [
      ...spread("tumatakbo", 4, 2, 14),
      ...spread("limitado", 3, 4, 16),
      ...spread("hindi_tumatakbo", 3, 6, 18),
    ],
    feedback: [
      { tripIssue: "okay_lang", tripSpeed: "sakto", passengerLevel: "puno", ageMin: 5 },
      { tripIssue: "tuloy_tuloy", tripSpeed: "mabilis", passengerLevel: "sakto", ageMin: 9 },
      { tripIssue: "okay_lang", tripSpeed: "matagal", passengerLevel: "tayuan", ageMin: 13 },
    ],
  },
  {
    key: "incident",
    expect: "Baha + aksidente chips, dominant Matagal, crowd Tayuan",
    reports: spread("hindi_tumatakbo", 5, 2, 20),
    feedback: [
      { tripIssue: "baha", tripSpeed: "matagal", passengerLevel: "tayuan", ageMin: 4 },
      { tripIssue: "baha", tripSpeed: "matagal", passengerLevel: "puno", ageMin: 12 },
      { tripIssue: "aksidente", tripSpeed: "matagal", passengerLevel: "tayuan", ageMin: 18 },
    ],
  },
  {
    key: "decaying",
    expect: "Counts still high but shares shifted — inside the window, past the decay start",
    reports: [...spread("tumatakbo", 4, 32, 38), ...spread("limitado", 3, 36, 44)],
    feedback: [
      { tripIssue: "okay_lang", tripSpeed: "sakto", passengerLevel: "sakto", ageMin: 34 },
      { tripIssue: "okay_lang", tripSpeed: "sakto", passengerLevel: "puno", ageMin: 41 },
    ],
  },
  {
    key: "stale",
    expect: "Empty summary, Hindi alam — everything is past the window",
    reports: [...spread("tumatakbo", 5, 50, 70)],
    feedback: [
      { tripIssue: "tuloy_tuloy", tripSpeed: "mabilis", passengerLevel: "kaunti", ageMin: 55 },
    ],
  },
  {
    key: "single-reporter",
    expect: "Suppressed breakdown (below the minimum), not a misleading 100% bar",
    reports: spread("tumatakbo", 1, 5, 5),
    feedback: [],
  },
  {
    key: "crowded-but-running",
    expect: "Dominant Mabilis with Puno/Tayuan crowd — crowd is independent of status",
    reports: [...spread("tumatakbo", 6, 2, 16), ...spread("limitado", 1, 8, 8)],
    feedback: [
      { tripIssue: "tuloy_tuloy", tripSpeed: "mabilis", passengerLevel: "tayuan", ageMin: 3 },
      { tripIssue: "tuloy_tuloy", tripSpeed: "mabilis", passengerLevel: "puno", ageMin: 8 },
      { tripIssue: "okay_lang", tripSpeed: "mabilis", passengerLevel: "tayuan", ageMin: 14 },
    ],
  },
  {
    key: "untouched",
    expect: "No reports at all — the Hindi alam empty state",
    reports: [],
    feedback: [],
  },
];

// ─── Wire-value mappings (mirrors routes/trip-feedback.ts) ───────────────────

const NEGATIVE_ISSUES = new Set<TripIssue>(["aksidente", "baha", "sarado"]);

function passengerToCrowd(level: PassengerLevel): "maluwag" | "katamtaman" | "siksikan" {
  if (level === "kaunti") return "maluwag";
  if (level === "sakto") return "katamtaman";
  return "siksikan";
}

function speedToRouteStatus(speed: TripSpeed): ReportStatus {
  if (speed === "mabilis") return "tumatakbo";
  if (speed === "sakto") return "limitado";
  return "hindi_tumatakbo";
}

// ─── SQL fragments ───────────────────────────────────────────────────────────

/**
 * A plausible geotag: a random point along the route's own geometry, falling
 * back to the Metro Manila centroid for routes imported without a line. Keeps
 * the seeded rows usable if geographic clustering is added later.
 */
function locationSql(routeId: string) {
  return sql`COALESCE(
    (
      SELECT ST_LineInterpolatePoint(tr.geometry::geometry, RANDOM())::geography
      FROM transit_routes tr
      WHERE tr.id = ${routeId}::uuid AND tr.geometry IS NOT NULL
    ),
    ST_SetSRID(ST_MakePoint(121.0244, 14.5547), 4326)::geography
  )`;
}

function agoSql(ageMin: number) {
  return sql`NOW() - (${ageMin} * INTERVAL '1 minute')`;
}

/**
 * Drizzle binds a JS array as a single record parameter, which Postgres will
 * not cast to an array type. Expand to a parameter list instead.
 */
function inListSql(values: string[], cast: "uuid" | "text") {
  return sql.join(
    values.map((v) => (cast === "uuid" ? sql`${v}::uuid` : sql`${v}::text`)),
    sql`, `,
  );
}

// ─── Seeding ─────────────────────────────────────────────────────────────────

type TargetRoute = { id: string; code: string; name: string };

async function upsertReporters(): Promise<void> {
  for (const r of REPORTERS) {
    await db.execute(sql`
      INSERT INTO users (id, first_name, last_name, display_name, credibility_score)
      VALUES (
        ${r.id}::uuid,
        'Seed',
        ${`Reporter ${String(r.index + 1).padStart(2, "0")}`},
        ${r.label},
        ${r.credibility}
      )
      ON CONFLICT (id) DO UPDATE SET credibility_score = EXCLUDED.credibility_score
    `);
  }
}

async function pickRoutes(codes: string[] | null): Promise<TargetRoute[]> {
  if (codes && codes.length > 0) {
    const res = await db.execute<TargetRoute>(sql`
      SELECT id, code, name FROM transit_routes
      WHERE code IN (${inListSql(codes, "text")}) AND is_active = 1
      ORDER BY code
    `);
    const found = new Set(res.rows.map((r) => r.code));
    const missing = codes.filter((c) => !found.has(c));
    if (missing.length > 0) logger.warn({ missing }, "requested route codes not found");
    return res.rows;
  }

  // Prefer routes with geometry so the map has something to draw and the
  // geotags land on the actual corridor.
  const res = await db.execute<TargetRoute>(sql`
    SELECT id, code, name FROM transit_routes
    WHERE is_active = 1 AND geometry IS NOT NULL
    ORDER BY code
    LIMIT ${SCENARIOS.length}
  `);
  return res.rows;
}

async function clearSeeded(): Promise<void> {
  const ids = inListSql(REPORTER_IDS, "uuid");
  const reports = await db.execute(sql`
    DELETE FROM reports WHERE user_id IN (${ids})
  `);
  const feedback = await db.execute(sql`
    DELETE FROM trip_feedback WHERE user_id IN (${ids})
  `);
  logger.info(
    { reports: reports.rowCount ?? 0, tripFeedback: feedback.rowCount ?? 0 },
    "cleared previously seeded rows",
  );
}

/** Round-robin reporters so each route draws a mix of credibility scores. */
function reporterFor(routeIndex: number, n: number) {
  const r = REPORTERS[(routeIndex * 3 + n) % REPORTERS.length];
  if (!r) throw new Error("no reporters configured");
  return r;
}

async function seedScenario(
  route: TargetRoute,
  scenario: Scenario,
  routeIndex: number,
): Promise<{ reports: number; feedback: number }> {
  let reportCount = 0;
  let feedbackCount = 0;

  for (const [n, rep] of scenario.reports.entries()) {
    const reporter = reporterFor(routeIndex, n);
    await db.execute(sql`
      INSERT INTO reports (
        client_uuid, user_id, route_id, status, crowd_level, location, weight, created_at
      ) VALUES (
        ${seededUuid(`${scenario.key}:${route.code}:report:${n}`)}::uuid,
        ${reporter.id}::uuid,
        ${route.id}::uuid,
        ${rep.status},
        NULL,
        ${locationSql(route.id)},
        ${reporter.credibility},
        ${agoSql(rep.ageMin)}
      )
      ON CONFLICT (user_id, client_uuid) DO NOTHING
    `);
    reportCount++;
  }

  for (const [n, fb] of scenario.feedback.entries()) {
    // Offset the reporter pool so a route's feedback authors differ from its
    // status reporters, the way separate commuters would.
    const reporter = reporterFor(routeIndex, n + 5);
    const clientUuid = seededUuid(`${scenario.key}:${route.code}:feedback:${n}`);
    await db.execute(sql`
      INSERT INTO trip_feedback (
        client_uuid, user_id, route_id, trip_issue, others_text,
        trip_speed, passenger_level, location, weight, created_at
      ) VALUES (
        ${clientUuid}::uuid,
        ${reporter.id}::uuid,
        ${route.id}::uuid,
        ${fb.tripIssue},
        NULL,
        ${fb.tripSpeed},
        ${fb.passengerLevel},
        ${locationSql(route.id)},
        ${reporter.credibility},
        ${agoSql(fb.ageMin)}
      )
      ON CONFLICT (user_id, client_uuid) DO NOTHING
    `);
    feedbackCount++;

    // Mirror the derived status report that POST /trip-feedback writes, so the
    // seeded state is one the real write path could actually produce.
    const derivedStatus = NEGATIVE_ISSUES.has(fb.tripIssue)
      ? "hindi_tumatakbo"
      : speedToRouteStatus(fb.tripSpeed);
    await db.execute(sql`
      INSERT INTO reports (
        client_uuid, user_id, route_id, status, crowd_level, location, weight, created_at
      ) VALUES (
        ${seededUuid(`${clientUuid}:status`)}::uuid,
        ${reporter.id}::uuid,
        ${route.id}::uuid,
        ${derivedStatus},
        ${passengerToCrowd(fb.passengerLevel)},
        ${locationSql(route.id)},
        ${reporter.credibility},
        ${agoSql(fb.ageMin)}
      )
      ON CONFLICT (user_id, client_uuid) DO NOTHING
    `);
    reportCount++;
  }

  return { reports: reportCount, feedback: feedbackCount };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const routesArg = args.find((a) => a.startsWith("--routes="));
  const codes = routesArg
    ? routesArg
        .slice("--routes=".length)
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
    : null;

  assertLocalDatabase();

  if (reset) await clearSeeded();
  else {
    logger.info(
      "inserting without --reset: existing seeded rows keep their original timestamps " +
        "and may already be outside the freshness window",
    );
  }

  await upsertReporters();

  const routes = await pickRoutes(codes);
  if (routes.length === 0) {
    throw new Error("no active routes with geometry found — run `npm run db:seed` first");
  }
  if (routes.length < SCENARIOS.length) {
    logger.warn(
      { available: routes.length, scenarios: SCENARIOS.length },
      "fewer routes than scenarios; some scenarios will be skipped",
    );
  }

  const answerKey: { scenario: string; code: string; routeId: string; expect: string }[] = [];
  let totalReports = 0;
  let totalFeedback = 0;

  for (const [i, scenario] of SCENARIOS.entries()) {
    const route = routes[i];
    if (!route) break;
    const { reports, feedback } = await seedScenario(route, scenario, i);
    totalReports += reports;
    totalFeedback += feedback;
    answerKey.push({
      scenario: scenario.key,
      code: route.code,
      routeId: route.id,
      expect: scenario.expect,
    });
  }

  logger.info({ reports: totalReports, tripFeedback: totalFeedback }, "seeded report rows");

  // Refresh route_status now so the map is correct immediately, instead of
  // depending on whether `npm run dev:worker` happens to be running.
  const { touchedRoutes } = await runAggregatorOnce();
  logger.info({ touchedRoutes }, "aggregator run complete");

  process.stdout.write("\nSeeded route scenarios — expected outcome per route:\n\n");
  for (const row of answerKey) {
    process.stdout.write(`  ${row.scenario.padEnd(21)} ${row.code.padEnd(14)} ${row.routeId}\n`);
    process.stdout.write(`  ${" ".repeat(21)} ${row.expect}\n\n`);
  }
  const first = answerKey[0];
  if (first) {
    process.stdout.write(
      `Verify one directly:\n  curl -s localhost:${env.PORT}/reports/route/${first.routeId}/summary | jq\n\n`,
    );
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    logger.error({ err }, "seed-reports failed");
    process.exit(1);
  });
