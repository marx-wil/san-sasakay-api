# syntax=docker/dockerfile:1.7

# ─── Stage 1: deps (cached unless package files change) ──────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev

# ─── Stage 2a: dev (full deps, source mounted at runtime) ───────────────────
# Used by docker-compose for hot-reloading via tsx watch.
FROM node:20-alpine AS dev
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.build.json drizzle.config.ts ./
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ─── Stage 2b: build (TypeScript -> dist/) ───────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && \
    npm prune --omit=dev

# ─── Stage 3: runtime (slim, non-root) ───────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# postgres-client is needed for backup/restore scripts on prod.
RUN apk add --no-cache postgresql16-client tini && \
    addgroup -S app && adduser -S app -G app

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/src/db/migrations ./src/db/migrations
COPY --from=build --chown=app:app /app/src/db/extensions.sql ./src/db/extensions.sql

USER app
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
