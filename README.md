# sakay-api

> Backend for [San Sasakay](../sakay-na-product-doc.html) — a crowdsourced real-time transit
> intelligence service for Metro Manila's informal transit ecosystem.

This service is the data plane behind:

- The mobile app at [`../sakay-app`](../sakay-app) (React Native + Expo).
- The landing page at [`../landing`](../landing) (Next.js).

It does **not** ship UI. It ships a JSON + WebSocket API, a Postgres database
with PostGIS + TimescaleDB, a small worker that aggregates crowdsourced reports
into live route status, and the Terraform + cloud-init bundle that puts all
of that on a single AWS EC2 instance for ~$11/month.

---

## Table of contents

1. [What this service does](#what-this-service-does)
2. [Architecture](#architecture)
3. [Tech stack and why](#tech-stack-and-why)
4. [Repo layout](#repo-layout)
5. [Local development](#local-development)
6. [Environment variables](#environment-variables)
7. [Database, schema, migrations](#database-schema-migrations)
8. [API surface](#api-surface)
9. [Authentication flow](#authentication-flow)
10. [Connecting the mobile app and landing page](#connecting-the-mobile-app-and-landing-page)
11. [Deploying to AWS](#deploying-to-aws)
12. [CI/CD pipeline](#cicd-pipeline)
13. [Operations runbook](#operations-runbook)
14. [Cost ceiling and scaling story](#cost-ceiling-and-scaling-story)
15. [Security notes](#security-notes)
16. [Troubleshooting](#troubleshooting)
17. [Migration path beyond MVP](#migration-path-beyond-mvp)

---

## What this service does

Three jobs, in order of importance:

1. **Ingest reports.** Commuters tap-to-report route status (`tumatakbo` /
   `limitado` / `hindi_tumatakbo`) and crowd level. Each report is geotagged,
   deduplicated by a client-supplied UUID, weighted by user credibility, and
   written to a Timescale-managed `reports` hypertable.

2. **Aggregate into live status.** A worker process recomputes
   `route_status` every 10 seconds: weighted majority vote across reports in
   the last 45 minutes, with linear decay starting at 30 minutes. Stale routes
   flip to `hindi_alam` ("unknown").

3. **Serve clients.** REST + WebSocket endpoints for the mobile app and
   landing page. Email magic-link auth for sign-in (phone added in Phase 2).

What's deliberately out of scope at MVP: report validation (👍/👎), points
redemption, B2G analytics dashboard, ML ETA, push notifications. See the
phased roadmap in [`../sakay-app/README.md`](../sakay-app/README.md).

---

## Architecture

```
                   ┌──────────────┐         ┌──────────────┐
                   │  Sakay App   │         │   Landing    │
                   │ (Expo, RN)   │         │  (Next.js)   │
                   └──────┬───────┘         └──────┬───────┘
                          │ JSON + WS              │ JSON
                          ▼                        ▼
        ╔═════════════════════════════════════════════════════════╗
        ║   Caddy (auto-TLS via Let's Encrypt)                    ║
        ║   :443 ──► Fastify API + WebSocket on :3000             ║
        ╠═════════════════════════════════════════════════════════╣
        ║   Postgres 16 + PostGIS + TimescaleDB                   ║
        ║   - reports (hypertable, 7d retention)                  ║
        ║   - route_status (denormalized, upserted every 10s)     ║
        ║   - users, identity_proofs, points_events, etc.         ║
        ╠═════════════════════════════════════════════════════════╣
        ║   Worker (Node) — aggregator tick @ 10s                 ║
        ╚═════════════════════════════════════════════════════════╝
                   single t4g.micro EC2 / Docker Compose
                          │
                          ├──► S3 (daily pg_dump, 30d retention)
                          ├──► SES (magic-link emails, prod only)
                          └──► CloudWatch Logs (bootstrap + Caddy access)
```

Local dev mirrors this exactly, except:

- **Caddy** is replaced by Fastify directly on `localhost:3000`.
- **SES** is replaced by [Mailpit](https://mailpit.axllent.org/) (web UI on
  `localhost:8025`) which catches all outbound mail.
- **S3 + CloudWatch + Cognito** are not used.

---

## Tech stack and why

| Layer | Choice | Rationale |
| --- | --- | --- |
| Runtime | Node.js 20 (LTS) | Same language as `sakay-app` and `landing`; large PH talent pool. |
| HTTP framework | Fastify 5 | ~2× faster than Express; first-class schema validation; WebSocket plugin. |
| Validation | Zod via `fastify-type-provider-zod` | Single source of truth for request/response shape, types inferred. |
| ORM | Drizzle | TypeScript-first, lightweight, raw-SQL escape hatch is first-class — best PostGIS story among ORMs. |
| Database | Postgres 16 + PostGIS (+ TimescaleDB available) | PostGIS for geospatial; TimescaleDB extension is loaded but `reports` is a regular table at MVP scale (see schema notes — converting to a hypertable conflicts with our offline-queue idempotency unique constraint). |
| Auth | Email magic-link (custom) + `@fastify/jwt` | Free via SES (62K/mo). Phone added Phase 2 via `identity_proofs` table — no schema migration. |
| WebSocket | `@fastify/websocket` | Live route status fan-out; in-process pub/sub for MVP, swap to Redis when we scale to >1 node. |
| Logging | Pino | JSON logs in prod, pretty logs in dev, redacts auth headers. |
| Lint + format | Biome | One tool, zero config drift, ~10× faster than ESLint+Prettier. |
| Reverse proxy + TLS | Caddy | Free Let's Encrypt automation, no cert renewal cron. |
| Container runtime | Docker + Compose v2 | Identical local + prod; image moves to ECS Fargate when we outgrow EC2. |
| IaC | Terraform | Reusable, lift-and-shift to Fargate later. Local state for MVP — migrate to S3 backend on day 2. |

Stack choices that **diverge** from the FRD's section 12, with rationale:

- **Self-hosted Postgres on EC2 instead of RDS** — RDS db.t3.micro alone costs
  ~$15/mo, eating the entire $16/mo budget. We pay for it with backup
  responsibility, but daily `pg_dump` to S3 is good enough at MVP scale.
- **No managed Redis** — ElastiCache micro is only free for 12 months and
  costs ~$12/mo after. We use Postgres + in-process LRU instead. Add Upstash
  Redis (free tier, external) when leaderboards demand sorted sets.
- **Email magic-link instead of phone OTP** — SMS in PH costs ~$0.06 each;
  email via SES is effectively free up to 62K/month. Phone is added in
  Phase 2 as a peer identity provider, not a replacement.

---

## Repo layout

```
sakay-api/
├── src/
│   ├── server.ts              # Fastify entry (HTTP + WS)
│   ├── config.ts              # zod-validated env
│   ├── db/
│   │   ├── client.ts          # pg pool + drizzle instance
│   │   ├── schema.ts          # ORM schema (source of truth for queries)
│   │   ├── migrations/        # hand-written .sql (source of truth for DB)
│   │   ├── extensions.sql     # CREATE EXTENSION ...
│   │   ├── migrate.ts         # custom migration runner
│   │   └── seed.ts            # dev seed (5 sample MM routes)
│   ├── auth/
│   │   ├── jwt.ts             # @fastify/jwt augmentation + requireAuth
│   │   ├── magic-link.ts      # SES + Mailpit providers, hashing
│   │   └── routes.ts          # POST /auth/request, GET /auth/verify
│   ├── routes/
│   │   ├── health.ts          # /health (liveness), /ready (DB ping)
│   │   ├── reports.ts         # POST /reports, GET /reports/me
│   │   ├── transit-routes.ts  # GET /routes, GET /routes/:id
│   │   └── ws.ts              # WebSocket subscribe per route
│   ├── workers/
│   │   ├── index.ts           # worker process entry
│   │   └── aggregator.ts      # 10s tick: weighted decay → route_status
│   └── lib/
│       ├── logger.ts          # pino, redacts auth, pretty in dev
│       └── errors.ts          # AppError + factories (BadRequest, etc.)
├── scripts/
│   ├── backup.sh              # pg_dump | gzip | aws s3 cp
│   └── restore.sh             # destructive restore from s3 dump
├── infra/
│   ├── terraform/             # EC2, EIP, SG, S3, IAM, SES
│   └── cloud-init/            # user-data.sh, Caddyfile
├── .github/workflows/
│   ├── ci.yml                 # lint + typecheck + docker build (no push)
│   └── deploy.yml             # build linux/arm64 → GHCR → SSM run-command
├── docker-compose.yml         # local dev stack
├── Dockerfile                 # multi-stage; runtime is alpine + tini
├── drizzle.config.ts          # for db:studio (introspection only)
├── tsconfig.json
├── biome.json
└── .env.example
```

---

## Local development

### Prerequisites

- **Docker Desktop** (or Docker Engine + Compose v2 on Linux/WSL2)
- **Node.js 20+** (only needed for editor / IDE tooling — the container has its own)
- **psql** (optional, for ad-hoc DB inspection)

You do **not** need an AWS account, an internet connection (after the first
image pull), or any SMS / email provider configured.

### First run

```bash
cd sakay-api

# Install deps locally (for IDE typechecking; the container installs its own).
npm install

# Copy the example env. The defaults work as-is for Docker Compose.
cp .env.example .env

# Boot the stack: postgres + mailpit + api + worker.
docker compose up
```

On first boot, the Postgres image runs [`src/db/extensions.sql`](src/db/extensions.sql)
to install PostGIS, TimescaleDB, pgcrypto, and pg_trgm. Then the API container
runs [`src/db/migrate.ts`](src/db/migrate.ts) which applies every file in
[`src/db/migrations/`](src/db/migrations/) in order and records them in a
`_migrations` ledger.

When you see this, the API is up:

```
sakay-api ready  host=0.0.0.0 port=3000 env=development
```

Smoke-test from another terminal:

```bash
curl http://localhost:3000/health
# {"ok":true,"service":"sakay-api"}

curl http://localhost:3000/ready
# {"ok":true,"db":"ok"}
```

### Useful URLs (local)

| What | Where |
| --- | --- |
| API | http://localhost:3000 |
| Mailpit web UI (catches magic-link emails) | http://localhost:8025 |
| Postgres | `postgres://sakay:sakay@localhost:5432/sakay` |
| Drizzle Studio | run `npm run db:studio` then open the URL it prints |

### Day-to-day commands

```bash
# Hot-reload (already running inside docker compose, but useful standalone):
npm run dev               # api on :3000
npm run dev:worker        # worker (separate terminal)

# Database
npm run db:migrate        # apply pending SQL migrations
npm run db:seed           # insert 5 sample MM routes
npm run db:studio         # browse data in a web UI

# Quality
npm run lint              # biome check
npm run lint:fix
npm run typecheck         # tsc --noEmit
```

### Trying the auth flow locally

```bash
# 1. Request a magic link. Always returns 202.
curl -X POST http://localhost:3000/auth/request \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'

# 2. Open Mailpit at http://localhost:8025, click the latest email, copy
#    the URL out of the link, and pull the token query param off the end.
#    Pass &format=json so curl gets a JSON body instead of a 302 redirect:
curl 'http://localhost:3000/auth/verify?token=PASTE_TOKEN_HERE&format=json'
# {"token":"<jwt>","user":{"id":"...","displayName":null,"hasPhone":false}}

# 3. Use the JWT for authenticated routes:
JWT='paste-jwt-here'
curl http://localhost:3000/me -H "Authorization: Bearer $JWT"

# 4. Set first / last name. Either field is optional; pass null (or an
#    empty string) to clear it, omit it to leave it untouched. The
#    response's `displayName` is server-composed from first + last.
curl -X PATCH http://localhost:3000/me \
  -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"firstName":"Juan","lastName":"dela Cruz"}'

# 5. Attach a phone number (any of these formats are accepted):
curl -X POST http://localhost:3000/me/phone \
  -H "Authorization: Bearer $JWT" \
  -H 'content-type: application/json' \
  -d '{"phone":"09171234567"}'
```

If you instead open the magic-link URL in a real browser, the API will
302-redirect you to `${PUBLIC_WEB_URL}/auth/callback#token=<jwt>`. The
landing app picks the token out of the URL fragment.

### Resetting the local DB

```bash
docker compose down -v        # also removes the postgres volume
docker compose up
```

---

## Environment variables

Full reference at [`.env.example`](.env.example). The non-obvious ones:

| Var | Purpose | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection string | In compose this points to the `postgres` service. |
| `JWT_SECRET` | HMAC secret for JWTs and identifier hashing | **Min 32 chars.** Generate with `openssl rand -base64 48`. |
| `EMAIL_PROVIDER` | `mailpit` (dev) or `ses` (prod) | Switches the magic-link sender. |
| `PUBLIC_API_URL` | Public URL the magic-link points back to | `http://localhost:3000` in dev, `https://api.<domain>` in prod. |
| `AGGREGATOR_TICK_SECONDS` | How often the worker recomputes `route_status` | Default 10s. Don't go below 5s without read-replica analysis. |
| `REPORT_DECAY_START_MINUTES` | Reports' weight starts decreasing at this age | Default 30. |
| `REPORT_EXPIRY_MINUTES` | Reports' weight is 0 after this age | Default 45. |

---

## Database, schema, migrations

### Source-of-truth split

- **Application source of truth**: [`src/db/schema.ts`](src/db/schema.ts) —
  Drizzle table definitions used for type-safe queries.
- **Database source of truth**: [`src/db/migrations/*.sql`](src/db/migrations/) —
  hand-written SQL applied in lexicographic order, **without** their own
  `BEGIN`/`COMMIT` (the runner wraps each migration in a transaction).

Why two? Drizzle can generate migrations from the ORM schema, but it does not
model `geography(Point,4326)` columns or GiST indexes. So we author the SQL by
hand and keep the ORM schema in sync manually. The schema file describes the
shape Drizzle queries against; the migrations describe the shape Postgres
actually has. Drift between them is caught at query time during local dev.

### Adding a new migration

```bash
# 1. Create a new file. Numbering is strictly increasing.
touch src/db/migrations/0002_add_validations.sql

# 2. Write idempotent-where-possible DDL inside a single transaction.
# 3. Update src/db/schema.ts to mirror.
# 4. npm run db:migrate
```

Migrations are immutable once applied — the runner stores a SHA-256 of each
file and refuses to run if a previously-applied file changes content. To
modify a table that's already deployed, write a new migration.

### Schema overview

| Table | Purpose | Notes |
| --- | --- | --- |
| `users` | Product-side user record | `credibility_score` defaults to 1.0; updated by anti-spam later. |
| `identity_proofs` | Auth identifiers (email now, phone/philsys later) | Composite PK lets one user have N proofs. Phase 2 phone = INSERT, no migration. |
| `magic_link_tokens` | Single-use email magic-link tokens | `token_hash` only; raw token never stored. |
| `transit_routes` | Jeepney / UV / P2P / tricycle / ferry routes | `geometry` is `geography(LineString,4326)` for accurate distance math. |
| `stops` | Ordered stops per route | Unique on `(route_id, seq)`. |
| `reports` | Crowdsourced route observations | Idempotent on `(user_id, client_uuid)`. Regular table at MVP scale; migrates to Timescale hypertable + separate dedup table when volume demands. |
| `route_status` | Denormalized current state per route | Upserted every 10s by the aggregator. |
| `points_events` | Append-only points ledger | Balance = `SUM(delta)` per user. |

---

## API surface

Concrete shapes are defined as Zod schemas in the route files; they double as
OpenAPI-style validation. Summary:

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | none | Liveness |
| GET | `/ready` | none | Readiness (pings DB) |
| POST | `/auth/request` | none | Send magic-link to email |
| GET | `/auth/verify?token=...` | none | Consume token, redirect to web with JWT in URL fragment |
| GET | `/auth/verify?token=...&format=json` | none | Same, but return `{token, user}` as JSON (programmatic) |
| GET | `/me` | JWT | Current user profile + points balance + which proofs are attached |
| PATCH | `/me` | JWT | Update first / last name |
| POST | `/me/phone` | JWT | Attach a PH mobile number (no SMS verification at MVP) |
| DELETE | `/me/phone` | JWT | Detach the phone proof |
| POST | `/reports` | JWT | Submit a route status report |
| GET | `/reports/me` | JWT | Recent reports for current user |
| GET | `/routes?bbox=...&type=...` | none | Routes intersecting a bbox |
| GET | `/routes/:id` | none | Full route detail + stops |
| WS | `/ws` | none (token in next phase) | Subscribe to live route status |

### Public vs authenticated routes (the guest-mode contract)

The clients support a "guest mode" where unauthenticated commuters can
still see routes and live status. Anything that is per-user — saved
routes, points/rewards, profile — sits behind `JWT`. The split:

- **Public** (no JWT, work in guest mode): `/health`, `/ready`,
  `/routes`, `/routes/:id`, `/auth/*`, `/ws`.
- **Authenticated** (JWT required, surfaced as locked features in the
  client): `/me`, `/me/phone`, `/reports`, `/reports/me`.

The server returns a stable `401 UNAUTHORIZED` on any authenticated
endpoint hit without a JWT — the client uses that as the signal to
render the "Mag-sign in to unlock" overlay rather than mid-screen
errors.

### `/me` payload

```jsonc
{
  "id": "9b3a...",
  "firstName": null,
  "lastName": null,
  // Server-composed: `${firstName} ${lastName}` if either is set, else any
  // legacy display_name from a pre-migration row, else null. Clients
  // should read this directly rather than re-deriving it.
  "displayName": null,
  "hasEmail": true,
  "hasPhone": false,
  "credibilityScore": 1.0,
  "pointsBalance": 0,
  "createdAt": "2026-04-30T01:23:45.000Z"
}
```

The client uses `hasPhone` to decide whether to prompt the user to add
a phone number after sign-in (see [Authentication flow](#authentication-flow)).

### Reporting (POST /reports)

```jsonc
// request
{
  "clientUuid": "550e8400-e29b-41d4-a716-446655440000",
  "routeId":    "f4b8...",
  "status":     "tumatakbo",
  "crowdLevel": "katamtaman",
  "location":   { "lng": 121.05, "lat": 14.62 }
}

// response (first time)
{ "id": "...", "pointsAwarded": 25, "duplicate": false }

// response (offline-queue retry)
{ "id": "...", "pointsAwarded": 0,  "duplicate": true  }
```

The `clientUuid` field is the **idempotency key** — set it once on the
device, retry as many times as needed. The DB has a unique constraint on
`(user_id, client_uuid)` so duplicates are silently coalesced.

### WebSocket protocol (/ws)

```jsonc
// client -> server
{ "type": "subscribe",   "routeIds": ["uuid1","uuid2"] }
{ "type": "unsubscribe", "routeIds": ["uuid1"] }
{ "type": "ping" }

// server -> client (after each aggregator tick that touched a subscribed route)
{
  "type": "status",
  "routeId": "uuid1",
  "status":  "limitado",
  "confidence": 0.72,
  "reportCount": 9,
  "lastReportAt": "2026-04-30T01:23:45.000Z"
}
```

---

## Authentication flow

Magic-link by email is the **only** sign-in method at MVP. Phone
numbers are collected *after* authentication via `POST /me/phone` so we
can wire SMS-OTP verification later without changing the boundary.

```
┌────────┐   POST /auth/request {email}    ┌─────────┐
│ Client │────────────────────────────────►│  API    │
└────────┘                                 └────┬────┘
                                                │ 1. hash email
                                                │ 2. random 24-byte token
                                                │ 3. store token_hash, exp=10min
                                                │ 4. send email (Mailpit dev / SES prod)
                                                ▼
┌────────┐   click link in email            ┌────────┐
│ Email  │─────────────────────────────────►│Browser │
└────────┘                                  └────┬───┘
                                                 │ GET /auth/verify?token=...
                                                 ▼
                                            ┌─────────┐
                                            │  API    │
                                            └────┬────┘
                                                 │ 1. hash incoming token, lookup
                                                 │ 2. verify not expired/used
                                                 │ 3. find-or-create user via identity_proofs
                                                 │ 4. mark token used + bump last_seen_at
                                                 │ 5. issue JWT (30-day TTL)
                                                 ▼
                                  302 → PUBLIC_WEB_URL/auth/callback#token=<JWT>
                                                 │
                                                 ▼
                            ┌────────────────────────────────────────┐
                            │  Web/app callback page reads fragment, │
                            │  stores JWT, fetches GET /me, then     │
                            │  prompts for phone if hasPhone=false.  │
                            └────────────────────────────────────────┘
```

Programmatic clients (the mobile app's foreground universal-link
handler, curl, integration tests) can opt out of the redirect by
appending `?format=json`, in which case `/auth/verify` returns
`{ token, user: { id, displayName, hasPhone } }` directly. The
default redirect flow is what the email client triggers when a
commuter taps the link from their inbox.

After sign-in, the client typically:

1. Calls `GET /me` to confirm the JWT is live and read the profile.
2. If `hasPhone === false`, shows a one-tap "Add your number" step
   that POSTs to `/me/phone`.
3. Hides "Mag-sign in to unlock" overlays on rewards / saved-routes
   surfaces.

Security details:

- The client sees the raw token only inside the magic-link URL. Server stores
  `SHA-256(token)` only.
- The email is never stored in plaintext. We store
  `SHA-256(JWT_SECRET || email_lowercased)` as `email_hash`. Phone numbers
  are normalized to E.164 (`+639XXXXXXXXX`) and hashed the same way. This
  means rotating `JWT_SECRET` is destructive — plan the rotation.
- POST `/auth/request` is rate-limited to 5/15min per IP and **always**
  returns `202` regardless of whether the email exists, to prevent account
  enumeration.
- The verify endpoint is single-use: `used_at` is stamped atomically with the
  token consumption.
- The redirect places the JWT in the URL **fragment** (`#token=...`), not
  the query string, so it is never sent to the server in subsequent
  navigations and never lands in access logs or referrer headers.
- POST `/me/phone` is rate-limited to 10/hour per user and rejects numbers
  already attached to a different account (`409 PHONE_TAKEN`). The phone
  proof is stored with `verified_at = NULL` at MVP — Phase 2 will add an
  SMS-OTP step that flips it.

---

## Connecting the mobile app and landing page

This is **out of scope for this repo's setup task** but flagged so you don't
forget when wiring the clients.

### `sakay-app` (Expo)

Add an `extra.apiBaseUrl` to [`../sakay-app/app.json`](../sakay-app/app.json):

```jsonc
{
  "expo": {
    "extra": {
      "apiBaseUrl": "http://10.0.2.2:3000"  // Android emulator
    }
  }
}
```

Read it via `expo-constants`:

```ts
import Constants from "expo-constants";
const baseUrl = Constants.expoConfig?.extra?.apiBaseUrl ?? "http://localhost:3000";
```

Use **`http://10.0.2.2:3000`** from an Android emulator (it's the host
machine's loopback) and **`http://<your-LAN-ip>:3000`** from a physical device
on the same Wi-Fi. iOS simulator can use `http://localhost:3000`.

### `landing` (Next.js)

```bash
echo 'NEXT_PUBLIC_API_BASE_URL=http://localhost:3000' > ../landing/.env.local
```

```ts
const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL!;
```

### CORS

Local dev allows all origins. Production restricts to `PUBLIC_WEB_URL`. Add
more origins explicitly in [`src/server.ts`](src/server.ts) when shipping
multiple clients.

---

## Deploying to AWS

### One-time AWS setup

1. **AWS account + access**: Create an IAM user with programmatic access. For
   day-to-day Terraform, use AWS SSO if available; for CI, use OIDC (see
   below).
2. **Buy a domain** (Route 53, Namecheap, or wherever). E.g. `sansasakay.example`.
   Skip this step if you only want a public IP for testing.
3. **Install tooling**:
   - `terraform >= 1.6`
   - `aws` CLI v2

### First apply

```bash
cd sakay-api/infra/terraform

# Configure your AWS credentials (sso, env vars, or ~/.aws/credentials).
aws sts get-caller-identity   # confirm you're who you think

# Optional vars file. Skipping this gives you a working IP-only deploy.
cat > terraform.tfvars <<EOF
domain_name        = "sansasakay.example"
api_subdomain      = "api"
letsencrypt_email  = "ops@sansasakay.example"
ghcr_image         = "ghcr.io/<your-gh-org>/sakay-api:latest"
EOF

terraform init
terraform plan
terraform apply
```

### After apply (one-time DNS work)

```bash
terraform output
```

Take the outputs and add the records to your DNS zone:

1. `dns_a_record` — A record pointing `api.sansasakay.example` at the EIP.
2. `ses_dkim_records` — three CNAME records, copy each `name`/`value`.
3. `ses_verification_token` — TXT at `_amazonses.<domain>` with the token as
   value.

Once DNS propagates (1–60 min), AWS verifies SES automatically. Until then,
SES sends fail. Until **production access** is granted, SES is in sandbox mode
and only allows mail to verified recipients. Request production access in the
SES console: _Account dashboard → Request production access._ This is
typically granted in 24h.

### Confirm the deploy worked

```bash
INSTANCE_ID=$(terraform output -raw instance_id)
aws ssm start-session --target "$INSTANCE_ID"
# inside the session:
sudo journalctl -u sakay -f      # service logs
sudo docker compose -f /opt/sakay/docker-compose.yml ps
sudo tail -n 200 /var/log/sakay-bootstrap.log
exit
```

External smoke test:

```bash
curl https://api.sansasakay.example/health
```

---

## CI/CD pipeline

Two GitHub Actions workflows live in [`.github/workflows/`](.github/workflows/).

### `ci.yml` — runs on every PR

- `npm ci`
- `biome check`
- `tsc --noEmit`
- Docker buildx build (no push) — proves the image still builds.

### `deploy.yml` — runs on push to `main`

1. Build a `linux/arm64` image (matches the t4g.micro architecture).
2. Push to GHCR as both `:latest` and `:<git-sha>`.
3. Assume an AWS role via OIDC.
4. `aws ssm send-command` to the EC2 instance: `cd /opt/sakay && docker
   compose pull && docker compose up -d`.
5. Poll until SSM reports success (3 min timeout).

### Required GitHub Secrets

| Secret | Value |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | ARN of an OIDC-trusted IAM role allowed to call `ssm:SendCommand` on your instance. |
| `AWS_EC2_INSTANCE_ID` | The instance ID from `terraform output instance_id`. |

Setting up the OIDC trust is a one-time chore — see AWS docs for [Configuring
OpenID Connect in Amazon Web
Services](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services).
The role needs only `ssm:SendCommand` on `arn:aws:ec2:*:*:instance/<id>` and
`ssm:ListCommandInvocations`.

### Seeding `transit_routes` in production

Migrations apply automatically on container boot (see
[`src/server.ts`](src/server.ts)). The OSM route seed does **not** —
it's a one-shot script that should run after the first deploy and again
after each refresh of upstream OSM data.

The Docker build embeds a fresh `data/osm-routes/metro-manila.geojson`
by running `npm run osm:fetch` against the Overpass API during the
`build` stage. So every deployed image carries a current OSM snapshot
ready to load. To actually load it:

```bash
INSTANCE_ID=$(aws ssm describe-instance-information \
  --filters "Key=tag:Name,Values=sakay-api-prod-ec2" \
  --query 'InstanceInformationList[0].InstanceId' --output text \
  --region ap-southeast-1)

aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "Seed transit_routes from OSM" \
  --parameters 'commands=["cd /opt/sakay && docker compose run --rm api node dist/db/seed.js"]' \
  --region ap-southeast-1
```

Idempotent: the seed upserts via `ON CONFLICT (code) DO UPDATE`, so
re-running it after a fresh deploy propagates upstream OSM edits to the
DB without manual SQL.

Build-time tradeoff: if Overpass is unreachable when CI runs, the image
build fails. That's deliberate — silently shipping a stale OSM snapshot
hides drift. Re-trigger the workflow when Overpass recovers (it usually
does within minutes).

---

## Operations runbook

### View live logs

```bash
INSTANCE_ID=$(terraform -chdir=infra/terraform output -raw instance_id)
aws ssm start-session --target "$INSTANCE_ID"
sudo docker logs -f sakay-api-1     # API
sudo docker logs -f sakay-worker-1  # aggregator worker
sudo docker logs -f sakay-postgres-1
```

CloudWatch Logs at `/sakay/bootstrap` and `/sakay/caddy` retain 7 days for
incident review.

### Manual backup (on top of daily cron)

```bash
aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["bash /etc/cron.daily/sakay-backup"]'
```

### Restore from backup

Find the dump you want:

```bash
aws s3 ls s3://sakay-api-prod-backups/sakay-api/ --recursive | sort -r | head
```

Then on the instance:

```bash
aws ssm start-session --target "$INSTANCE_ID"
cd /opt/sakay
docker compose stop api worker
DATABASE_URL="postgres://sakay:<pwd>@localhost:5432/sakay" \
  /opt/sakay/restore.sh s3://sakay-api-prod-backups/sakay-api/<TS>/dump.sql.gz
docker compose start api worker
```

(The `<pwd>` lives in `/opt/sakay/.env` — `grep DATABASE_URL /opt/sakay/.env`.)

### Rolling forward after a bad deploy

Both `:latest` and `:<git-sha>` tags are pushed. To pin to a previous SHA:

```bash
ssh-or-ssm into instance:
cd /opt/sakay
sed -i "s|:latest|:<good-sha>|g" docker-compose.yml
docker compose pull && docker compose up -d
```

Long term: switch deploy.yml to write a `versions.env` to `/opt/sakay/` and
restart by sourcing it.

### Memory pressure on `t4g.micro`

`free -h` to check. Postgres is the dominant consumer. Quick mitigations:

- Lower `pg_pool.max` from 10 to 5 in `src/db/client.ts`.
- Set `shared_buffers=128MB` in the postgres container env.
- Resize: `terraform apply -var instance_type=t4g.small` (~$15.50/mo) — this
  takes the instance down for ~3 min.

---

## Cost ceiling and scaling story

### Monthly cost (ap-southeast-1)

| Item | Cost |
| --- | --- |
| EC2 `t4g.micro` 24/7 | $7.74 |
| EBS gp3 20 GB | $1.60 |
| Elastic IP (attached) | $0.00 |
| S3 backups (~1 GB at any time, 30d retention) | $0.30 |
| CloudFront (optional, MVP traffic) | $0–1.00 |
| Data transfer out | $0 (first 100 GB/mo free per AWS) |
| Route 53 (one zone) | $0.50 |
| SQS, Cognito, CloudWatch Logs, SES (62K emails) | $0 |
| **Total** | **~$10–11/mo** |

185-day projection on $100 credit: **~$60 spent, ~$40 headroom**.

### When does this stop being enough?

| Trigger | Mitigation |
| --- | --- |
| Postgres `shared_buffers` evicting | Bump to `t4g.small` (~$15.50/mo, +$8 vs micro). |
| Aggregator tick > 1s | Add Redis cache for `route_status` reads, keep tick on Postgres. |
| WAR > 10K, write QPS > 50 | Migrate Postgres to RDS db.t4g.medium ($28/mo) + connection pooling. |
| Multi-engineer team | Move TF state to S3+DynamoDB backend; add staging env. |
| Need WS to >5K concurrent | Front the API with an ALB ($18/mo) and add a 2nd instance. |

The Docker image, schema, and IaC are all designed to lift-and-shift to
ECS Fargate + RDS + ALB + ElastiCache without rewrites. See the FRD section 12
for the long-term target stack.

---

## Security notes

- **No raw PII in the database.** Email and phone are stored only as
  `SHA-256(JWT_SECRET || identifier)`. Rotate `JWT_SECRET` only as part of a
  planned migration that re-derives identifier hashes.
- **No password storage.** The whole product avoids passwords.
- **JWTs expire in 30 days.** Renewed by re-running the magic-link flow.
- **Rate limits**: 5 magic-link requests / 15 min per IP, 20 reports / hour
  per user (per FRD § 8).
- **Reports cap location to PH bbox** (115–127 lng, 4–22 lat) at the API
  layer to reject bogus payloads early.
- **All TLS via Caddy + Let's Encrypt** in prod; local dev is plain HTTP.
- **EC2 metadata service v2 only** (`http_tokens=required`) — blocks SSRF
  exploits that read instance creds.
- **SSH only from your operator IP** by default; prefer `aws ssm
  start-session` for shell access (audited, no key management).
- **S3 bucket is private with Block Public Access enforced**.

---

## Troubleshooting

### "extension postgis does not exist" during migration

The official Postgres image was used instead of `timescale/timescaledb-ha`.
Confirm the image in [`docker-compose.yml`](docker-compose.yml). If you're on
prod, the `cloud-init/user-data.sh` writes the right image.

### "checksum mismatch for 0001_init.sql"

Someone edited a migration file after it was applied. **Don't do that.**
Either revert the change or, if the change is needed, write a new migration.

### Magic link works locally but not in prod

99% of the time SES is still in sandbox mode. Check the SES console; request
production access. Until granted, SES rejects mail to unverified addresses.

### Worker keeps logging "aggregator tick failed"

Most likely the worker started before Postgres extensions were registered.
The `depends_on: condition: service_healthy` in compose handles this in dev;
in prod, the API container runs migrations on boot before Caddy proxies
requests, but the worker doesn't. If it crash-loops, restart it manually:

```bash
sudo docker compose -f /opt/sakay/docker-compose.yml restart worker
```

### `docker compose up` says "no matching manifest for linux/arm64"

You're on an Apple Silicon Mac. The Postgres image we use has `arm64` builds;
if you swapped it, make sure the replacement does too. Same goes for prod —
the `t4g.micro` is `arm64`, so the GHCR image must include a `linux/arm64`
manifest. The deploy workflow already builds for `arm64` only.

### Mailpit shows nothing

Confirm `EMAIL_PROVIDER=mailpit` in `.env`. The provider switch is at
[`src/auth/magic-link.ts`](src/auth/magic-link.ts) — `ses` will silently fail
in dev because there are no SES credentials.

---

## Migration path beyond MVP

The day this stack stops fitting is the day Phase 2 ships. Here's the plan,
in order of expected pain:

1. **Postgres → RDS.** `pg_dump` → `pg_restore` to a Multi-AZ RDS instance.
   Update `DATABASE_URL`. Drop the postgres service from compose. Total
   downtime: ~10 min.
2. **EC2 → ECS Fargate.** Same Docker image. Define a task definition, point
   at a new ALB, drop the EIP. Caddy gets replaced by ALB + ACM cert. Total
   downtime: ~0 min if done with DNS swing.
3. **Add Redis (Upstash free, then ElastiCache).** Move `route_status` reads
   behind a cache; move leaderboards out of Postgres entirely.
4. **Phone auth.** Add `provider='phone'` rows to `identity_proofs`. Wire
   Cognito (or stay custom) + SNS. Charge to Phase-2 budget; expected
   ~$50–200/mo at MVP scale.
5. **Push notifications.** FCM topic per route + per user. Consume from a new
   `report_created` table-valued event stream (we'll add Postgres logical
   decoding via `wal2json`).
6. **B2G analytics plane.** CDC → S3 → BigQuery. dbt models for 500m-radius
   aggregates with PII strip. Metabase as the read layer. Lives in a separate
   repo; this service emits the firehose.

Each step is independent. You can ship them in any order revenue lets you.

---

## Pointers

- San Sasakay product doc: [`../sakay-na-product-doc.html`](../sakay-na-product-doc.html)
- San Sasakay FRD: [`../sakay-na-frd.html`](../sakay-na-frd.html)
- Mobile app: [`../sakay-app`](../sakay-app)
- Landing page: [`../landing`](../landing)

> _"Makakauwi ka ba?"_ — that's the question. This is the API answering it.
