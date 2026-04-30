import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Independent of LOG_LEVEL. Set true to dump every SQL query Drizzle issues.
  // Useful for debugging a specific query path; very noisy in steady state.
  LOG_SQL: z
    .union([z.boolean(), z.string()])
    .transform((v) => (typeof v === "string" ? v.toLowerCase() === "true" : v))
    .default(false),

  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),

  PUBLIC_API_URL: z.string().url(),
  PUBLIC_WEB_URL: z.string().url(),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  JWT_ISSUER: z.string().default("sakay-api"),
  JWT_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 30),

  MAGIC_LINK_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  EMAIL_PROVIDER: z.enum(["mailpit", "ses"]).default("mailpit"),
  EMAIL_FROM: z.string().min(1),

  SMTP_HOST: z.string().default("mailpit"),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),

  AWS_REGION: z.string().default("ap-southeast-1"),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  S3_BACKUP_BUCKET: z.string().optional(),

  AGGREGATOR_TICK_SECONDS: z.coerce.number().int().positive().default(10),
  REPORT_DECAY_START_MINUTES: z.coerce.number().int().positive().default(30),
  REPORT_EXPIRY_MINUTES: z.coerce.number().int().positive().default(45),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  process.stderr.write("Invalid environment configuration:\n");
  process.stderr.write(`${JSON.stringify(parsed.error.flatten().fieldErrors, null, 2)}\n`);
  process.exit(1);
}

export const env: Env = parsed.data;
export const isProd = env.NODE_ENV === "production";
export const isDev = env.NODE_ENV === "development";
