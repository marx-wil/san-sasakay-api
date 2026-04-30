import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// ─── Custom PostGIS types ────────────────────────────────────────────────────
// Stored as WGS84 geography. We marshal via EWKT on the wire — Postgres casts
// `'SRID=4326;POINT(lng lat)'` to geography(Point,4326) automatically when
// bound to a geography column. Reads return the canonical EWKT string; route
// handlers convert to GeoJSON via ST_AsGeoJSON for clients.

export type LngLat = { lng: number; lat: number };

export const geographyPoint = customType<{
  data: LngLat;
  driverData: string;
}>({
  dataType() {
    return "geography(Point,4326)";
  },
  toDriver(value: LngLat): string {
    return `SRID=4326;POINT(${value.lng} ${value.lat})`;
  },
});

export const geographyLineString = customType<{
  data: string; // EWKT in/out — geometries are admin-managed, not user input.
  driverData: string;
}>({
  dataType() {
    return "geography(LineString,4326)";
  },
});

// ─── Enums (as text + CHECK in migration; keeps schema portable) ─────────────
export const REPORT_STATUS = ["tumatakbo", "limitado", "hindi_tumatakbo"] as const;
export type ReportStatus = (typeof REPORT_STATUS)[number];

export const CROWD_LEVEL = ["maluwag", "katamtaman", "siksikan"] as const;
export type CrowdLevel = (typeof CROWD_LEVEL)[number];

export const ROUTE_STATUS = ["tumatakbo", "limitado", "hindi_tumatakbo", "hindi_alam"] as const;
export type RouteStatus = (typeof ROUTE_STATUS)[number];

export const TRANSIT_TYPE = ["jeepney", "uv_express", "p2p_bus", "tricycle", "ferry"] as const;
export type TransitType = (typeof TRANSIT_TYPE)[number];

export const IDENTITY_PROVIDER = ["email", "phone", "philsys"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDER)[number];

export const POINTS_EVENT_KIND = [
  "report_submitted",
  "report_validated_by_other",
  "validated_other",
  "streak_multiplier",
  "redemption_debit",
  "manual_grant",
] as const;
export type PointsEventKind = (typeof POINTS_EVENT_KIND)[number];

// ─── users ──────────────────────────────────────────────────────────────────
// Auth credentials live in identity_proofs; users carries product state only.
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayName: text("display_name"),
    credibilityScore: real("credibility_score").notNull().default(1.0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  },
  (t) => ({
    createdAtIdx: index("users_created_at_idx").on(t.createdAt),
  }),
);

// ─── identity_proofs ────────────────────────────────────────────────────────
// One row per (user, provider, identifier). Email is required at MVP signup;
// phone and philsys are added in later phases without schema changes.
export const identityProofs = pgTable(
  "identity_proofs",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().$type<IdentityProvider>(),
    // SHA-256 of the lowercased identifier. We never store raw email/phone.
    identifierHash: text("identifier_hash").notNull(),
    // Optional encrypted payload for redemption flows that need the raw value.
    // (Out of scope for MVP — column reserved for Phase 2.)
    encryptedIdentifier: text("encrypted_identifier"),
    isPrimary: integer("is_primary").notNull().default(1),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.provider, t.identifierHash] }),
    providerHashUq: unique("identity_proofs_provider_hash_uq").on(t.provider, t.identifierHash),
    userIdx: index("identity_proofs_user_idx").on(t.userId),
  }),
);

// ─── magic_link_tokens ──────────────────────────────────────────────────────
// Single-use email magic-link tokens. Hash the token at rest.
export const magicLinkTokens = pgTable(
  "magic_link_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    emailHash: text("email_hash").notNull(),
    // userId is null until first verification (signup-on-verify pattern).
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    expiresIdx: index("magic_link_tokens_expires_idx").on(t.expiresAt),
    emailIdx: index("magic_link_tokens_email_idx").on(t.emailHash),
  }),
);

// ─── transit_routes ─────────────────────────────────────────────────────────
export const transitRoutes = pgTable(
  "transit_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(), // e.g. "JEEP-014" or community label
    name: text("name").notNull(), // human-readable, Filipino-first
    type: text("type").notNull().$type<TransitType>(),
    geometry: geographyLineString("geometry"),
    isActive: integer("is_active").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUq: unique("transit_routes_code_uq").on(t.code),
    typeIdx: index("transit_routes_type_idx").on(t.type),
    // GiST index on geometry created in migration SQL (Drizzle doesn't model GIST yet).
  }),
);

// ─── stops ──────────────────────────────────────────────────────────────────
export const stops = pgTable(
  "stops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routeId: uuid("route_id")
      .notNull()
      .references(() => transitRoutes.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    name: text("name").notNull(),
    location: geographyPoint("location").notNull(),
  },
  (t) => ({
    routeSeqUq: unique("stops_route_seq_uq").on(t.routeId, t.seq),
  }),
);

// ─── reports ────────────────────────────────────────────────────────────────
// Regular table at MVP scale. Migration to a Timescale hypertable is deferred
// until volume justifies the partitioning overhead — and requires moving
// idempotency to a separate dedup table because hypertable unique constraints
// must include the partition column. See 0001_init.sql for the rationale.
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").defaultRandom(),
    // Client-supplied UUID for offline-queue idempotency. (clientUuid, userId) unique.
    clientUuid: uuid("client_uuid").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    routeId: uuid("route_id")
      .notNull()
      .references(() => transitRoutes.id, { onDelete: "cascade" }),
    status: text("status").notNull().$type<ReportStatus>(),
    crowdLevel: text("crowd_level").$type<CrowdLevel>(),
    location: geographyPoint("location").notNull(),
    // Snapshot of user.credibilityScore at submission time. Aggregator weights by this.
    weight: real("weight").notNull().default(1.0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.createdAt] }), // composite PK required for hypertables.
    clientUq: unique("reports_user_client_uq").on(t.userId, t.clientUuid),
    routeTimeIdx: index("reports_route_time_idx").on(t.routeId, t.createdAt),
    createdAtIdx: index("reports_created_at_idx").on(t.createdAt),
  }),
);

// ─── route_status ───────────────────────────────────────────────────────────
// Denormalized current state per route. Aggregator worker upserts this every tick.
export const routeStatus = pgTable("route_status", {
  routeId: uuid("route_id")
    .primaryKey()
    .references(() => transitRoutes.id, { onDelete: "cascade" }),
  status: text("status").notNull().$type<RouteStatus>().default("hindi_alam"),
  // 0..1, derived from report count + recency + agreement.
  confidence: real("confidence").notNull().default(0),
  reportCount: integer("report_count").notNull().default(0),
  // Last contributing report time — used to render "last 20 min" trust signal.
  lastReportAt: timestamp("last_report_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── points_events ──────────────────────────────────────────────────────────
// Append-only ledger. Balance = SUM(delta) WHERE user_id = ?.
// Materialized view + Redis cache come later when this becomes hot.
export const pointsEvents = pgTable(
  "points_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().$type<PointsEventKind>(),
    delta: integer("delta").notNull(),
    // Free-form FK reference: report_id, redemption_id, etc.
    refId: text("ref_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userTimeIdx: index("points_events_user_time_idx").on(t.userId, t.createdAt),
  }),
);

// ─── Type exports for ergonomic queries ─────────────────────────────────────
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type IdentityProof = typeof identityProofs.$inferSelect;
export type NewIdentityProof = typeof identityProofs.$inferInsert;
export type TransitRoute = typeof transitRoutes.$inferSelect;
export type Stop = typeof stops.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type NewReport = typeof reports.$inferInsert;
export type RouteStatusRow = typeof routeStatus.$inferSelect;
export type PointsEvent = typeof pointsEvents.$inferSelect;
export type MagicLinkToken = typeof magicLinkTokens.$inferSelect;

// Re-exported `sql` for callers that need raw fragments.
export { sql };
