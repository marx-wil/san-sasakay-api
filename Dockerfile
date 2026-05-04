# syntax=docker/dockerfile:1.7
#
# Base image is node:20-bookworm-slim (glibc) instead of node:20-alpine (musl).
# Rationale: when CI builds linux/arm64 on an amd64 runner via QEMU, musl+Node
# reliably SIGILLs during `npm ci` with native modules. glibc is stable under
# QEMU. Switch back to -alpine once this repo goes public and CI can use
# runs-on: ubuntu-24.04-arm (native, no QEMU).

# ─── Stage 1: deps (cached unless package files change) ──────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev

# ─── Stage 2a: dev (full deps, source mounted at runtime) ───────────────────
# Used by docker-compose for hot-reloading via tsx watch.
FROM node:20-bookworm-slim AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.build.json drizzle.config.ts ./
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ─── Stage 2b: build (TypeScript -> dist/) ───────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && \
    npm prune --omit=dev

# ─── Stage 3: runtime (slim, non-root) ───────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# postgres-client is needed for backup/restore scripts on prod.
# tini reaps zombies from `node dist/server.js` under PID 1.
RUN apt-get update && \
    apt-get install -y --no-install-recommends postgresql-client tini && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r app && useradd -r -g app -d /app app

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json
# migrate.ts resolves these paths via `import.meta.url`, which at runtime
# points into ./dist/db/. Co-locate the SQL with the compiled JS so the
# runtime image works without extra path-mapping in code.
COPY --from=build --chown=app:app /app/src/db/migrations ./dist/db/migrations
COPY --from=build --chown=app:app /app/src/db/extensions.sql ./dist/db/extensions.sql

USER app
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
