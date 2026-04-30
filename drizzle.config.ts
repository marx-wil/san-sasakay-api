import { defineConfig } from "drizzle-kit";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://sakay:sakay@localhost:5432/sakay";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
  verbose: true,
  strict: true,
});
