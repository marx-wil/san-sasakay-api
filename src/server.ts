import cors from "@fastify/cors";
import jwtPlugin from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import {
  type ZodTypeProvider,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import { authRoutes } from "./auth/routes.js";
import { env, isDev } from "./config.js";
import { migrate } from "./db/migrate.js";
import { AppError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { healthRoutes } from "./routes/health.js";
import { meRoutes } from "./routes/me.js";
import { reportRoutes } from "./routes/reports.js";
import { transitRouteRoutes } from "./routes/transit-routes.js";
import { wsRoutes } from "./routes/ws.js";

async function buildServer() {
  const app = Fastify({
    // Fastify v5: pass a pre-built logger as `loggerInstance`. The `logger`
    // option is reserved for plain config objects (or `true`/`false`).
    loggerInstance: logger,
    // Fastify's auto request logging emits two multi-line entries per call.
    // We disable it and emit a single concise line per response below.
    disableRequestLogging: true,
    trustProxy: true,
    bodyLimit: 1024 * 256, // 256KB. Reports are tiny; keeps malicious uploads cheap.
    ajv: { customOptions: { coerceTypes: false } },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);

  await app.register(cors, {
    origin: isDev ? true : [env.PUBLIC_WEB_URL],
    credentials: false,
  });

  await app.register(rateLimit, {
    global: false, // Per-route opt-in.
    max: 100,
    timeWindow: "1 minute",
  });

  await app.register(jwtPlugin, {
    secret: env.JWT_SECRET,
    sign: {
      iss: env.JWT_ISSUER,
      expiresIn: env.JWT_TTL_SECONDS,
    },
    verify: { allowedIss: env.JWT_ISSUER },
  });

  await app.register(websocket, {
    options: { maxPayload: 1024 * 16 },
  });

  // ─── Concise per-request log ──────────────────────────────────────────────
  // One line per HTTP request: "GET /reports 201 12ms".
  // Health checks log at debug (silent by default). 4xx -> warn, 5xx -> error.
  app.addHook("onResponse", (req, reply, done) => {
    const ms = Math.round(reply.elapsedTime);
    const url = req.url;
    const status = reply.statusCode;
    const ctx = { method: req.method, url, status, ms };
    const msg = `${req.method} ${url} ${status} ${ms}ms`;
    if (url === "/health" || url === "/ready") {
      req.log.debug(ctx, msg);
    } else if (status >= 500) {
      req.log.error(ctx, msg);
    } else if (status >= 400) {
      req.log.warn(ctx, msg);
    } else {
      req.log.info(ctx, msg);
    }
    done();
  });

  // Routes.
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(meRoutes, { prefix: "/me" });
  await app.register(reportRoutes, { prefix: "/reports" });
  await app.register(transitRouteRoutes, { prefix: "/routes" });
  await app.register(wsRoutes); // /ws

  // Centralized error handler.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.statusCode).send({
        error: err.code,
        message: err.message,
        details: err.details,
      });
      return;
    }
    // Fastify errors carry .validation, .statusCode, .code as optional fields.
    const fastifyErr = err as {
      validation?: unknown;
      statusCode?: number;
      code?: string;
      message?: string;
    };
    if (fastifyErr.validation) {
      reply.status(400).send({
        error: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: fastifyErr.validation,
      });
      return;
    }
    if (fastifyErr.statusCode && fastifyErr.statusCode < 500) {
      reply.status(fastifyErr.statusCode).send({
        error: fastifyErr.code ?? "BAD_REQUEST",
        message: fastifyErr.message ?? "Bad request",
      });
      return;
    }
    req.log.error({ err }, "Unhandled error");
    reply.status(500).send({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: "NOT_FOUND", message: "Route not found" });
  });

  return app;
}

async function start() {
  // Run migrations before binding the listener so we never serve traffic
  // against a stale schema.
  await migrate();

  const app = await buildServer();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Shutdown failed");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info({ host: env.HOST, port: env.PORT, env: env.NODE_ENV }, "sakay-api ready");
}

start().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
