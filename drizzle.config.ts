import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL ?? "postgres://sakay:sakay@localhost:5432/sakay";

export default defineConfig({
  schema: "./src/db/schema.ts",
  // Studio / introspection only. Do not `drizzle-kit generate` here: kit
  // emits `"geography(Point,4326)"` (quoted), which Postgres rejects.
  // Schema SQL is hand-written in this folder (see 0001_init.sql).
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
  verbose: true,
  strict: true,
});
