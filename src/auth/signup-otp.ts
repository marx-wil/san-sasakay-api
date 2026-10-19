import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "../config.js";
import { db } from "../db/client.js";
import { pendingSignups } from "../db/schema.js";
import { BadRequest } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { BRAND, mailer } from "../lib/mail.js";
import { hashToken } from "./magic-link.js";

const MAX_OTP_ATTEMPTS = 5;
const ENC_ALGO = "aes-256-gcm";

function encryptionKey(): Buffer {
  return createHash("sha256").update(`${env.JWT_SECRET}::signup-pw`).digest();
}

function encryptPassword(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENC_ALGO, encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

function decryptPassword(payload: string): string {
  const buf = Buffer.from(payload, "base64url");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv(ENC_ALGO, encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export function generateSignupOtp(): string {
  return String(randomInt(100_000, 1_000_000));
}

export async function sendSignupOtp(email: string, code: string): Promise<void> {
  const subject = "I-verify ang San Sasakay account mo";
  const ttlHours = Math.round(env.SIGNUP_OTP_TTL_SECONDS / 3600);
  const year = new Date().getFullYear();

  const text = [
    "San Sasakay",
    "",
    "Ang verification code mo:",
    code,
    "",
    `Mag-e-expire ang code sa loob ng ${ttlHours} oras.`,
    "",
    "Hindi ikaw ang humiling nito? Balewalain mo na lang ang email.",
    "",
    `© ${year} San Sasakay`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="tl">
  <head><meta charset="utf-8" /><title>${subject}</title></head>
  <body style="margin:0;padding:32px 16px;background:${BRAND.bg};font-family:${BRAND.sans};color:${BRAND.ink};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;">
      <tr>
        <td style="background:${BRAND.card};border:1px solid ${BRAND.rule};border-radius:2px;padding:32px;">
          <h1 style="margin:0 0 16px;font-family:${BRAND.serif};font-size:24px;font-weight:400;">
            I-verify ang <em style="color:${BRAND.accent};font-style:italic;">account</em> mo
          </h1>
          <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:${BRAND.ink2};">
            Ilagay ang code na ito sa app:
          </p>
          <p style="margin:0 0 24px;font-family:${BRAND.mono};font-size:28px;letter-spacing:0.2em;color:${BRAND.ink};">
            ${code}
          </p>
          <p style="margin:0;font-family:${BRAND.mono};font-size:11px;text-transform:uppercase;color:${BRAND.ink3};">
            Mag-e-expire sa ${ttlHours} oras
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  try {
    await mailer.send({ to: email, subject, text, html });
  } catch (err) {
    logger.error({ err, provider: env.EMAIL_PROVIDER }, "signup-otp send failed");
    throw err;
  }
}

export type PendingSignupPayload = {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phoneE164?: string;
};

export async function storePendingSignup(
  emailHash: string,
  opts: PendingSignupPayload,
): Promise<string> {
  const code = generateSignupOtp();
  const codeHash = hashToken(code);
  const expiresAt = new Date(Date.now() + env.SIGNUP_OTP_TTL_SECONDS * 1000);

  await db
    .insert(pendingSignups)
    .values({
      emailHash,
      codeHash,
      passwordCiphertext: encryptPassword(opts.password),
      firstName: opts.firstName,
      lastName: opts.lastName,
      phoneE164: opts.phoneE164 ?? null,
      attempts: 0,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: pendingSignups.emailHash,
      set: {
        codeHash,
        passwordCiphertext: encryptPassword(opts.password),
        firstName: opts.firstName,
        lastName: opts.lastName,
        phoneE164: opts.phoneE164 ?? null,
        attempts: 0,
        expiresAt,
      },
    });

  return code;
}

export async function verifyPendingSignup(
  emailHash: string,
  code: string,
): Promise<PendingSignupPayload> {
  const [row] = await db
    .select()
    .from(pendingSignups)
    .where(eq(pendingSignups.emailHash, emailHash))
    .limit(1);

  if (!row) {
    throw BadRequest("INVALID_CODE", "Mali ang verification code");
  }

  const now = Date.now();
  if (row.expiresAt.getTime() <= now) {
    await db.delete(pendingSignups).where(eq(pendingSignups.emailHash, emailHash));
    throw BadRequest("INVALID_CODE", "Expired na ang code. Humiling ng bago.");
  }

  if (row.attempts >= MAX_OTP_ATTEMPTS) {
    await db.delete(pendingSignups).where(eq(pendingSignups.emailHash, emailHash));
    throw BadRequest("INVALID_CODE", "Masyadong maraming subok. Mag-sign up ulit.");
  }

  const codeHash = hashToken(code.trim());
  if (codeHash !== row.codeHash) {
    await db
      .update(pendingSignups)
      .set({ attempts: row.attempts + 1 })
      .where(eq(pendingSignups.emailHash, emailHash));
    throw BadRequest("INVALID_CODE", "Mali ang verification code");
  }

  // Do not delete the row here — /auth/confirm still needs to create the Cognito
  // user. If that step fails (e.g. IAM), the commuter must be able to retry the
  // same OTP without the pending row vanishing.
  return {
    email: "",
    password: decryptPassword(row.passwordCiphertext),
    firstName: row.firstName,
    lastName: row.lastName,
    phoneE164: row.phoneE164 ?? undefined,
  };
}

export async function deletePendingSignup(emailHash: string): Promise<void> {
  await db.delete(pendingSignups).where(eq(pendingSignups.emailHash, emailHash));
}
