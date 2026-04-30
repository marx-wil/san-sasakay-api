import pino from "pino";
import { env, isDev } from "../config.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "sakay-api" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.token", "*.jwt"],
    censor: "[redacted]",
  },
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          // Hide noisy structural fields. reqId is kept by default; we
          // strip it too because the message already has the request shape.
          ignore: "pid,hostname,service,reqId",
          // Render structured fields inline so request logs are one line each.
          singleLine: true,
        },
      }
    : undefined,
});

export type Logger = typeof logger;
