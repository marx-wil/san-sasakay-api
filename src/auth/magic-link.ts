import { createHash, randomBytes } from "node:crypto";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { env } from "../config.js";
import { logger } from "../lib/logger.js";

/**
 * Hash sensitive identifiers before they hit the DB. Salted by JWT_SECRET
 * (which is also our app-wide pepper) so the hash isn't trivially rainbow-able.
 */
export function hashIdentifier(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  return createHash("sha256").update(`${env.JWT_SECRET}::${normalized}`).digest("hex");
}

/** Plain SHA-256 (no pepper) for short-lived tokens — fast lookup at /verify. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** URL-safe base64 token. 192 bits of entropy. */
export function generateMagicToken(): string {
  return randomBytes(24).toString("base64url");
}

// ─── Mail providers ─────────────────────────────────────────────────────────
interface MailProvider {
  send(args: { to: string; subject: string; text: string; html: string }): Promise<void>;
}

class MailpitProvider implements MailProvider {
  async send(args: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void> {
    // Use Mailpit's HTTP API instead of SMTP to avoid an SMTP client dep.
    const url = `http://${env.SMTP_HOST}:8025/api/v1/send`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        From: { Email: stripAddress(env.EMAIL_FROM) },
        To: [{ Email: args.to }],
        Subject: args.subject,
        Text: args.text,
        HTML: args.html,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Mailpit send failed: ${res.status} ${body}`);
    }
  }
}

class SesProvider implements MailProvider {
  private client = new SESClient({ region: env.AWS_REGION });

  async send(args: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        Source: env.EMAIL_FROM,
        Destination: { ToAddresses: [args.to] },
        Message: {
          Subject: { Data: args.subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: args.text, Charset: "UTF-8" },
            Html: { Data: args.html, Charset: "UTF-8" },
          },
        },
      }),
    );
  }
}

function stripAddress(emailFrom: string): string {
  // "San Sasakay <no-reply@x>" -> "no-reply@x"
  const m = emailFrom.match(/<([^>]+)>/);
  return m?.[1] ?? emailFrom;
}

const provider: MailProvider =
  env.EMAIL_PROVIDER === "ses" ? new SesProvider() : new MailpitProvider();

export async function sendMagicLink(email: string, link: string): Promise<void> {
  const subject = "Mag-sign in sa San Sasakay";
  const text = [
    "Pindutin ang link para mag-sign in:",
    link,
    "",
    `Mag-e-expire ito sa loob ng ${Math.round(env.MAGIC_LINK_TTL_SECONDS / 60)} minuto.`,
    "Kung hindi ikaw ang humiling nito, balewalain mo na lang ang email.",
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h1 style="font-size:20px;margin:0 0 12px">Mag-sign in sa San Sasakay</h1>
      <p style="color:#374151;margin:0 0 20px">Pindutin ang button para mag-sign in:</p>
      <p style="margin:0 0 24px">
        <a href="${link}" style="display:inline-block;background:#10b981;color:white;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
          Mag-sign in
        </a>
      </p>
      <p style="color:#6b7280;font-size:13px;margin:0 0 8px">
        Mag-e-expire ito sa loob ng ${Math.round(env.MAGIC_LINK_TTL_SECONDS / 60)} minuto.
      </p>
      <p style="color:#9ca3af;font-size:12px;margin:0">
        Kung hindi ikaw ang humiling nito, balewalain mo na lang ang email.
      </p>
    </div>
  `;

  try {
    await provider.send({ to: email, subject, text, html });
  } catch (err) {
    logger.error({ err, provider: env.EMAIL_PROVIDER }, "magic-link send failed");
    throw err;
  }
}
