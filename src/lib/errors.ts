/**
 * Domain errors. Map to HTTP status in the Fastify error handler.
 * Keep the codes stable — clients may switch on `error.code`.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(opts: {
    statusCode: number;
    code: string;
    message: string;
    details?: unknown;
  }) {
    super(opts.message);
    this.name = "AppError";
    this.statusCode = opts.statusCode;
    this.code = opts.code;
    this.details = opts.details;
  }
}

export const BadRequest = (code: string, message: string, details?: unknown) =>
  new AppError({ statusCode: 400, code, message, details });

export const Unauthorized = (code = "UNAUTHORIZED", message = "Unauthorized") =>
  new AppError({ statusCode: 401, code, message });

export const Forbidden = (code = "FORBIDDEN", message = "Forbidden") =>
  new AppError({ statusCode: 403, code, message });

export const NotFound = (code = "NOT_FOUND", message = "Not found") =>
  new AppError({ statusCode: 404, code, message });

export const Conflict = (code: string, message: string, details?: unknown) =>
  new AppError({ statusCode: 409, code, message, details });

export const TooManyRequests = (code = "RATE_LIMITED", message = "Too many requests") =>
  new AppError({ statusCode: 429, code, message });
