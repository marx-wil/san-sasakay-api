/**
 * Shared report freshness window + decay math.
 *
 * Two independent code paths consume raw reports and must agree on what
 * "recent" means and how much an ageing report is worth:
 *
 *   - the aggregator worker, which writes route_status (the hot-path value
 *     every route on the map carries), and
 *   - GET /reports/route/:routeId[/summary], which reads raw rows for the
 *     single route whose detail sheet is open.
 *
 * When these drift, the sheet contradicts the badge above it on the same
 * screen — the exact kind of inconsistency that costs commuter trust. So the
 * window and the decay curve live here, once.
 */

import { sql } from "drizzle-orm";
import { env } from "../config.js";

/** Reports older than this contribute nothing. */
export const WINDOW_MINUTES = env.REPORT_EXPIRY_MINUTES;

/** Reports keep full weight up to this age, then decay linearly to zero. */
export const DECAY_START_MINUTES = env.REPORT_DECAY_START_MINUTES;

/**
 * Below this many contributing reports we publish the dominant value and its
 * confidence, but not the per-option distribution.
 *
 * A lone report rendered as "100% Mabilis" reads as consensus when it is one
 * person's guess, and on a quiet route it makes that person's answer trivially
 * identifiable. The dominant value is still published, because withholding it
 * would contradict the status badge the aggregator already shows for the same
 * route — and low confidence is the honest way to say "barely known".
 */
export const MIN_REPORTS_FOR_BREAKDOWN = 2;

/**
 * Age in minutes of `column`, as a fractional number.
 * Pass a qualified column reference, e.g. `r.created_at`.
 */
export function ageMinutesSql(column: ReturnType<typeof sql.raw>) {
  return sql`EXTRACT(EPOCH FROM (NOW() - ${column})) / 60.0`;
}

/**
 * Linear time-decay factor in [0, 1] for a precomputed `age_min` expression.
 *
 * Full weight until DECAY_START_MINUTES, then a straight line to zero at
 * WINDOW_MINUTES. Callers multiply this by the report's credibility weight.
 */
export function decayFactorSql(ageMinExpr = sql.raw("age_min")) {
  const span = WINDOW_MINUTES - DECAY_START_MINUTES;
  return sql`GREATEST(
    0,
    CASE
      WHEN ${ageMinExpr} <= ${DECAY_START_MINUTES} THEN 1.0
      ELSE 1.0 - ((${ageMinExpr} - ${DECAY_START_MINUTES}) / NULLIF(${span}, 0))
    END
  )`;
}

/** `INTERVAL 'n minutes'` for the freshness window. */
export function windowIntervalSql() {
  return sql.raw(`INTERVAL '${WINDOW_MINUTES} minutes'`);
}

/**
 * `INTERVAL 'n minutes'` for the window immediately preceding the current
 * one — used to compute a report-volume trend.
 */
export function previousWindowIntervalSql() {
  return sql.raw(`INTERVAL '${WINDOW_MINUTES * 2} minutes'`);
}

/**
 * Volume saturation term for confidence: a route needs this many reports
 * before agreement alone can produce full confidence.
 */
export const CONFIDENCE_SATURATION_REPORTS = 8;
