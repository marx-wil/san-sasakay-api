import { sql } from "drizzle-orm";
import { env } from "../config.js";
import { db } from "../db/client.js";
import { logger } from "../lib/logger.js";

/**
 * RouteStatus aggregator.
 *
 * Runs every AGGREGATOR_TICK_SECONDS. For each route with at least one report
 * in the last REPORT_EXPIRY_MINUTES window, recomputes:
 *   - status        : weighted majority among report.status
 *   - confidence    : 0..1, based on report count + agreement + recency
 *   - report_count  : count of contributing reports
 *   - last_report_at
 *
 * Reports decay linearly from REPORT_DECAY_START_MINUTES to REPORT_EXPIRY_MINUTES,
 * weighted by user credibility at submission time (snapshotted in reports.weight).
 *
 * Routes with no reports in the window stay at last value, with status flipping
 * to 'hindi_alam' once stale.
 *
 * This is intentionally a single SQL upsert — it's cheap, deterministic, and
 * runs in well under a second on Phase 1 volumes.
 */
export async function runAggregatorOnce(): Promise<{ touchedRoutes: number }> {
  const decayStart = env.REPORT_DECAY_START_MINUTES;
  const expiry = env.REPORT_EXPIRY_MINUTES;

  const result = await db.execute<{ route_id: string }>(sql`
    WITH windowed AS (
      SELECT
        r.route_id,
        r.status,
        r.weight,
        r.created_at,
        EXTRACT(EPOCH FROM (NOW() - r.created_at)) / 60.0 AS age_min
      FROM reports r
      WHERE r.created_at > NOW() - INTERVAL '${sql.raw(String(expiry))} minutes'
    ),
    weighted AS (
      SELECT
        route_id,
        status,
        weight * GREATEST(
          0,
          CASE
            WHEN age_min <= ${decayStart} THEN 1.0
            ELSE 1.0 - ((age_min - ${decayStart}) / NULLIF(${expiry - decayStart}, 0))
          END
        ) AS w,
        created_at
      FROM windowed
    ),
    per_status AS (
      SELECT route_id, status, SUM(w) AS sw, COUNT(*) AS cnt, MAX(created_at) AS last_at
      FROM weighted
      WHERE w > 0
      GROUP BY route_id, status
    ),
    ranked AS (
      SELECT
        route_id,
        status,
        sw,
        cnt,
        last_at,
        SUM(sw) OVER (PARTITION BY route_id) AS total_w,
        SUM(cnt) OVER (PARTITION BY route_id) AS total_cnt,
        MAX(last_at) OVER (PARTITION BY route_id) AS route_last_at,
        ROW_NUMBER() OVER (PARTITION BY route_id ORDER BY sw DESC) AS rn
      FROM per_status
    ),
    winners AS (
      SELECT
        route_id,
        status,
        total_cnt::INTEGER AS report_count,
        route_last_at AS last_report_at,
        -- Confidence: agreement share * volume saturation.
        -- Agreement = winner_weight / total_weight (0..1).
        -- Volume saturation = LEAST(1, total_cnt / 8)  — 8+ reports = full confidence.
        LEAST(1.0, (sw / NULLIF(total_w, 0)) * LEAST(1.0, total_cnt::REAL / 8.0))::REAL AS confidence
      FROM ranked
      WHERE rn = 1
    )
    INSERT INTO route_status (route_id, status, confidence, report_count, last_report_at, updated_at)
    SELECT route_id, status, confidence, report_count, last_report_at, NOW()
    FROM winners
    ON CONFLICT (route_id) DO UPDATE
      SET status         = EXCLUDED.status,
          confidence     = EXCLUDED.confidence,
          report_count   = EXCLUDED.report_count,
          last_report_at = EXCLUDED.last_report_at,
          updated_at     = NOW()
    RETURNING route_id
  `);

  // Flip stale routes to 'hindi_alam'.
  await db.execute(sql`
    UPDATE route_status
    SET status = 'hindi_alam',
        confidence = 0,
        updated_at = NOW()
    WHERE status <> 'hindi_alam'
      AND (last_report_at IS NULL OR last_report_at < NOW() - INTERVAL '${sql.raw(
        String(expiry),
      )} minutes')
  `);

  return { touchedRoutes: result.rows.length };
}

export function startAggregator(): { stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const t0 = Date.now();
      const { touchedRoutes } = await runAggregatorOnce();
      const ms = Date.now() - t0;
      // Only log when something actually happened, or when a tick is slow
      // enough to care about. Empty ticks log at trace (off by default).
      if (touchedRoutes > 0) {
        logger.info({ touchedRoutes, ms }, "aggregator updated routes");
      } else if (ms > 500) {
        logger.warn({ ms }, "slow aggregator tick");
      } else {
        logger.trace({ ms }, "aggregator tick (no-op)");
      }
    } catch (err) {
      logger.error({ err }, "aggregator tick failed");
    } finally {
      running = false;
    }
  };

  // Fire once immediately, then on interval.
  void tick();
  timer = setInterval(tick, env.AGGREGATOR_TICK_SECONDS * 1000);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
