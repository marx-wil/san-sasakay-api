import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { env } from "../config.js";
import { db } from "../db/client.js";
import { magicLinkTokens } from "../db/schema.js";
import { BadRequest, Unauthorized } from "../lib/errors.js";
import { cognitoConfirmSignUp, cognitoPasswordLogin, cognitoSignUp } from "./cognito.js";
import {
  generateMagicToken,
  hashIdentifier,
  hashToken,
  normalizePhPhone,
  sendMagicLink,
} from "./magic-link.js";
import { issueSessionForEmail } from "./session.js";
import { findOrCreateUserByEmailHash, stampEarlyAdopter, touchLastSeen } from "./users.js";

// #region agent log
// Debug instrumentation. Container reaches host loopback via host.docker.internal.
function dlog(payload: {
  location: string;
  message: string;
  data?: Record<string, unknown>;
  hypothesisId?: string;
}): void {
  try {
    fetch("http://host.docker.internal:7652/ingest/12fcec5a-657d-4abd-b83d-ebfbba60b53a", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "1b02c8",
      },
      body: JSON.stringify({
        sessionId: "1b02c8",
        location: payload.location,
        message: payload.message,
        data: payload.data ?? {},
        hypothesisId: payload.hypothesisId,
        timestamp: Date.now(),
      }),
    }).catch(() => {});
  } catch {}
}
// #endregion

const RequestBody = z.object({
  email: z.string().email().max(254),
});

const VerifyQuery = z.object({
  token: z.string().min(20).max(64),
  // Default flow is a 302 redirect to PUBLIC_WEB_URL/auth/callback so the
  // email link "just works" when tapped on a phone. Programmatic callers
  // (mobile app, curl, tests) opt into JSON with ?format=json.
  format: z.enum(["json", "redirect"]).optional(),
});

const VerifyResponse = z.object({
  token: z.string(),
  user: z.object({
    id: z.string().uuid(),
    displayName: z.string().nullable(),
    hasPhone: z.boolean(),
    // Explicit "next step is phone" signal so the client doesn't have to
    // infer the post-auth route from `hasPhone`. Today equals `!hasPhone`;
    // when SMS-OTP ships, this will additionally require verifiedAt.
    phoneRequired: z.boolean(),
  }),
});

const StatusBody = z.object({
  token: z.string().min(20).max(64),
});

const StatusResponse = z.object({
  status: z.enum(["valid", "expired", "used", "invalid"]),
});

const PasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(128)
  .regex(/[a-z]/, "Password must include a lowercase letter")
  .regex(/[A-Z]/, "Password must include an uppercase letter")
  .regex(/[0-9]/, "Password must include a number");

const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

const SignUpBody = z
  .object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().email().max(254),
    password: PasswordSchema,
    passwordConfirm: z.string().min(1).max(128),
    phone: z.string().max(32).optional(),
  })
  .refine((b) => b.password === b.passwordConfirm, {
    message: "Passwords do not match",
    path: ["passwordConfirm"],
  });

const ConfirmBody = z.object({
  email: z.string().email().max(254),
  code: z.string().trim().min(6).max(6),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().max(32).optional(),
});

const SessionResponse = z.object({
  token: z.string().optional(),
  confirmationRequired: z.literal(true).optional(),
  user: z
    .object({
      id: z.string().uuid(),
      displayName: z.string().nullable(),
      hasPhone: z.boolean(),
      phoneRequired: z.boolean(),
    })
    .optional(),
});

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  // POST /auth/request — accepts an email, sends a magic-link.
  // Always returns 202 to prevent account enumeration: the response shape
  // is identical whether the email exists, is malformed-but-zod-valid, or
  // the upstream mail provider failed.
  app.post(
    "/request",
    {
      schema: {
        tags: ["auth"],
        body: RequestBody,
        response: {
          202: z.object({ ok: z.literal(true) }),
        },
      },
      config: {
        rateLimit: { max: 5, timeWindow: "15 minutes" },
      },
    },
    async (req, reply) => {
      // #region agent log
      dlog({
        location: "auth/routes.ts:/auth/request",
        message: "handler entered",
        data: { ip: req.ip, ua: req.headers["user-agent"]?.slice(0, 80) },
        hypothesisId: "A,B,C",
      });
      // #endregion
      const { email } = req.body;
      const emailHash = hashIdentifier(email);

      const token = generateMagicToken();
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + env.MAGIC_LINK_TTL_SECONDS * 1000);

      try {
        await db.insert(magicLinkTokens).values({
          tokenHash,
          emailHash,
          expiresAt,
        });
        // #region agent log
        dlog({
          location: "auth/routes.ts:/auth/request",
          message: "magic-link row inserted",
          hypothesisId: "C",
        });
        // #endregion
      } catch (err) {
        // #region agent log
        dlog({
          location: "auth/routes.ts:/auth/request",
          message: "magic-link insert threw",
          data: { errMessage: (err as Error)?.message ?? String(err) },
          hypothesisId: "C",
        });
        // #endregion
        throw err;
      }

      // Email CTA points at the web (sansasakay.com), not the API. The
      // /auth/verify page on the landing peeks POST /auth/status first,
      // then deep-links into the mobile app via the sansasakay:// scheme
      // only when the token is still valid. The web page never calls
      // GET /auth/verify itself, so the magic token isn't burned if the
      // user opened the email on the wrong device.
      const link = `${env.PUBLIC_WEB_URL}/auth/verify?token=${token}`;

      try {
        await sendMagicLink(email, link);
        // #region agent log
        dlog({
          location: "auth/routes.ts:/auth/request",
          message: "sendMagicLink resolved (mailpit accepted)",
          hypothesisId: "D",
        });
        // #endregion
      } catch (err) {
        // #region agent log
        dlog({
          location: "auth/routes.ts:/auth/request",
          message: "sendMagicLink threw",
          data: {
            errMessage: (err as Error)?.message ?? String(err),
            smtpHost: env.SMTP_HOST,
          },
          hypothesisId: "D",
        });
        // #endregion
        // Don't leak send failures to the client. Log + still return 202.
        req.log.error({ err }, "magic-link send failed");
      }

      reply.code(202);
      return { ok: true as const };
    },
  );

  // POST /auth/login — email + password via Cognito, then issue app JWT.
  app.post(
    "/login",
    {
      schema: {
        tags: ["auth"],
        body: LoginBody,
        response: { 200: SessionResponse },
      },
      config: {
        rateLimit: { max: 10, timeWindow: "15 minutes" },
      },
    },
    async (req) => {
      const email = req.body.email.trim().toLowerCase();
      const identity = await cognitoPasswordLogin(email, req.body.password);
      return issueSessionForEmail(app, {
        email: identity.email,
        firstName: identity.firstName,
        lastName: identity.lastName,
      });
    },
  );

  // POST /auth/signup — register in Cognito + sync profile to sakay DB.
  app.post(
    "/signup",
    {
      schema: {
        tags: ["auth"],
        body: SignUpBody,
        response: { 200: SessionResponse },
      },
      config: {
        rateLimit: { max: 5, timeWindow: "1 hour" },
      },
    },
    async (req) => {
      const email = req.body.email.trim().toLowerCase();
      let phoneE164: string | undefined;
      if (req.body.phone && req.body.phone.trim().length > 0) {
        try {
          phoneE164 = normalizePhPhone(req.body.phone);
        } catch {
          throw BadRequest(
            "INVALID_PHONE",
            "Phone must be a valid PH mobile number (e.g. 09171234567)",
          );
        }
      }

      const { userConfirmed } = await cognitoSignUp({
        email,
        password: req.body.password,
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        phoneE164,
      });

      if (!userConfirmed) {
        return { confirmationRequired: true as const };
      }

      return issueSessionForEmail(app, {
        email,
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        phone: req.body.phone,
      });
    },
  );

  // POST /auth/confirm — verify Cognito email code after signup.
  app.post(
    "/confirm",
    {
      schema: {
        tags: ["auth"],
        body: ConfirmBody,
        response: { 200: SessionResponse },
      },
      config: {
        rateLimit: { max: 10, timeWindow: "15 minutes" },
      },
    },
    async (req) => {
      const email = req.body.email.trim().toLowerCase();
      await cognitoConfirmSignUp(email, req.body.code);
      return issueSessionForEmail(app, {
        email,
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        phone: req.body.phone,
      });
    },
  );

  // POST /auth/status — read-only peek for the landing /auth/verify page.
  // Does not consume the token, create a user, or issue a JWT. The landing
  // uses this to refuse deep-linking expired/used links into the app.
  app.post(
    "/status",
    {
      schema: {
        tags: ["auth"],
        body: StatusBody,
        response: {
          200: StatusResponse,
        },
      },
      config: {
        rateLimit: { max: 20, timeWindow: "15 minutes" },
      },
    },
    async (req) => {
      const tokenHash = hashToken(req.body.token);
      const now = Date.now();

      const [row] = await db
        .select({
          expiresAt: magicLinkTokens.expiresAt,
          usedAt: magicLinkTokens.usedAt,
        })
        .from(magicLinkTokens)
        .where(eq(magicLinkTokens.tokenHash, tokenHash))
        .limit(1);

      if (!row) return { status: "invalid" as const };
      if (row.usedAt) return { status: "used" as const };
      if (row.expiresAt.getTime() <= now) return { status: "expired" as const };
      return { status: "valid" as const };
    },
  );

  // GET /auth/verify?token=... — consumes the token, signs in (or signs up).
  //
  // Two response styles:
  //   - default (browser-tap from email): 302 redirect to
  //     PUBLIC_WEB_URL/auth/callback#token=<JWT>. The fragment is never sent
  //     to the server, so the JWT doesn't leak via referer or proxy logs.
  //     The web/app callback page is responsible for stashing it.
  //   - ?format=json: returns { token, user } as JSON. Used by the mobile
  //     app when it can intercept the link itself (universal links) and by
  //     curl in the README.
  app.get(
    "/verify",
    {
      schema: {
        tags: ["auth"],
        querystring: VerifyQuery,
        response: {
          // Only the JSON path declares a schema; the 302 redirect emits a
          // minimal body that Fastify writes itself, no validation needed.
          200: VerifyResponse,
        },
      },
    },
    async (req, reply) => {
      const { token, format } = req.query;
      const tokenHash = hashToken(token);
      const now = new Date();

      const [row] = await db
        .select()
        .from(magicLinkTokens)
        .where(
          and(
            eq(magicLinkTokens.tokenHash, tokenHash),
            isNull(magicLinkTokens.usedAt),
            gt(magicLinkTokens.expiresAt, now),
          ),
        )
        .limit(1);

      if (!row) {
        // For browser flow, redirect to the callback with an error so the
        // landing page can render a friendly message instead of a JSON 401.
        if (format !== "json") {
          const url = new URL("/auth/callback", env.PUBLIC_WEB_URL);
          url.hash = "error=invalid_token";
          reply.redirect(url.toString(), 302);
          return;
        }
        throw Unauthorized("INVALID_TOKEN", "Magic link is invalid or expired");
      }

      const { userId, displayName, hasPhone } = await findOrCreateUserByEmailHash(row.emailHash);

      await stampEarlyAdopter(userId, row.emailHash);

      // Mark token used (single-use). Done after user resolution so a DB
      // failure during user creation doesn't burn the token.
      await db
        .update(magicLinkTokens)
        .set({ usedAt: now, userId })
        .where(eq(magicLinkTokens.tokenHash, tokenHash));

      await touchLastSeen(userId);

      const accessToken = app.jwt.sign({ sub: userId });

      if (format === "json") {
        return {
          token: accessToken,
          user: { id: userId, displayName, hasPhone, phoneRequired: !hasPhone },
        };
      }

      const url = new URL("/auth/callback", env.PUBLIC_WEB_URL);
      // URL fragment is not sent to the server on subsequent requests, so
      // the JWT doesn't appear in access logs or referrer headers.
      url.hash = `token=${encodeURIComponent(accessToken)}`;
      reply.redirect(url.toString(), 302);
      return;
    },
  );
};
