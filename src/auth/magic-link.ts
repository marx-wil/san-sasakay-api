import { createHash, randomBytes } from "node:crypto";
import { env } from "../config.js";
import { logger } from "../lib/logger.js";
import { BRAND, mailer } from "../lib/mail.js";

/**
 * Hash sensitive identifiers before they hit the DB. Salted by JWT_SECRET
 * (which is also our app-wide pepper) so the hash isn't trivially rainbow-able.
 */
export function hashIdentifier(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  return createHash("sha256").update(`${env.JWT_SECRET}::${normalized}`).digest("hex");
}

/**
 * Normalize a Philippine mobile number to E.164 (`+639XXXXXXXXX`).
 *
 * Accepts the formats commuters actually type:
 *   - `09171234567`             (local zero-prefix, 11 digits)
 *   - `9171234567`              (no prefix, 10 digits, starts with 9)
 *   - `+639171234567`           (already E.164)
 *   - `639171234567`            (international, missing +)
 *   - `0917 123 4567` / dashes  (any whitespace/punctuation)
 *
 * Throws if it doesn't look like a PH mobile number. We deliberately do
 * NOT accept landlines — every commuter-facing feature assumes mobile.
 */
export function normalizePhPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");

  let national: string;
  if (digits.startsWith("63") && digits.length === 12) {
    national = digits.slice(2);
  } else if (digits.startsWith("0") && digits.length === 11) {
    national = digits.slice(1);
  } else if (digits.length === 10) {
    national = digits;
  } else {
    throw new Error("INVALID_PH_PHONE");
  }

  // PH mobile numbers always start with 9.
  if (!national.startsWith("9")) throw new Error("INVALID_PH_PHONE");

  return `+63${national}`;
}

/** Plain SHA-256 (no pepper) for short-lived tokens — fast lookup at /verify. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** URL-safe base64 token. 192 bits of entropy. */
export function generateMagicToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function sendMagicLink(email: string, link: string): Promise<void> {
  const subject = "Mag-sign in sa San Sasakay";
  const ttlMinutes = Math.round(env.MAGIC_LINK_TTL_SECONDS / 60);
  const year = new Date().getFullYear();

  const text = [
    "San Sasakay",
    "",
    "Mag-sign in sa San Sasakay",
    "",
    "Pindutin ang link sa baba para makapasok sa app. Walang password — sa email mo lang.",
    "",
    link,
    "",
    `Mag-e-expire ang link na ito sa loob ng ${ttlMinutes} minuto.`,
    "",
    "Hindi ikaw ang humiling nito? Balewalain mo na lang ang email — walang ibang gagawin.",
    "",
    "—",
    "Para sa bawat Pilipinong umuuwi.",
    `© ${year} San Sasakay`,
  ].join("\n");

  // Hidden preheader text — what most inbox previews show beside the
  // subject line. Padded with whitespace so the client doesn't trail
  // it with the visible body text.
  const preheader = `Pindutin ang button para mag-sign in. Mag-e-expire sa ${ttlMinutes} minuto.`;

  // Table-based layout for Outlook compatibility. Every style is inline
  // because Gmail strips <style> blocks on quoted/forwarded mail and
  // some Outlook builds ignore them outright.
  const html = `<!doctype html>
<html lang="tl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.bg};font-family:${BRAND.sans};color:${BRAND.ink};-webkit-font-smoothing:antialiased;">
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;color:${BRAND.bg};">
      ${preheader}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.bg};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
            <!-- Wordmark -->
            <tr>
              <td style="padding:0 0 28px 0;">
                <span style="font-family:${BRAND.serif};font-size:26px;line-height:1;letter-spacing:-0.01em;color:${BRAND.ink};">San <em style="color:${BRAND.accent};font-style:italic;">Sasakay</em>.</span>
              </td>
            </tr>

            <!-- Hero card -->
            <tr>
              <td style="background:${BRAND.card};border:1px solid ${BRAND.rule};border-radius:2px;padding:36px 32px 32px 32px;">
                <h1 style="margin:0 0 16px 0;font-family:${BRAND.serif};font-size:28px;line-height:1.2;font-weight:400;color:${BRAND.ink};letter-spacing:-0.01em;">
                  Mag-sign in sa <em style="color:${BRAND.accent};font-style:italic;">San Sasakay</em>.
                </h1>
                <p style="margin:0 0 28px 0;font-family:${BRAND.sans};font-size:15px;line-height:1.55;color:${BRAND.ink2};">
                  Pindutin ang button sa baba para makapasok sa app. Walang password — sa email mo lang.
                </p>

                <!-- CTA button. Bulletproof table-based button so Outlook
                     renders the full hit-area, not just the text. -->
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px 0;">
                  <tr>
                    <td align="center" bgcolor="${BRAND.ink}" style="background:${BRAND.ink};border-radius:2px;">
                      <a href="${link}" style="display:inline-block;padding:14px 28px;font-family:${BRAND.mono};font-size:13px;line-height:1;letter-spacing:0.04em;text-transform:uppercase;color:#ffffff;text-decoration:none;border:1px solid ${BRAND.ink};border-radius:2px;">
                        Mag-sign in
                      </a>
                    </td>
                  </tr>
                </table>

                <!-- Plain-link fallback. The URL is intentionally rendered
                     as the link text so users can verify the destination
                     before clicking — important for a sign-in email. -->
                <p style="margin:0 0 8px 0;font-family:${BRAND.sans};font-size:13px;line-height:1.5;color:${BRAND.ink3};">
                  Hindi gumagana ang button? Kopyahin ang link na ito:
                </p>
                <p style="margin:0 0 24px 0;font-family:${BRAND.mono};font-size:12px;line-height:1.5;color:${BRAND.ink2};word-break:break-all;">
                  <a href="${link}" style="color:${BRAND.ink2};text-decoration:underline;">${link}</a>
                </p>

                <!-- Expiry chip -->
                <p style="margin:0;font-family:${BRAND.mono};font-size:11px;line-height:1;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.ink3};">
                  <span style="display:inline-block;padding:6px 10px;border:1px solid ${BRAND.rule};border-radius:2px;background:${BRAND.bg};">
                    Mag-e-expire sa ${ttlMinutes} minuto
                  </span>
                </p>
              </td>
            </tr>

            <!-- Divider -->
            <tr>
              <td style="padding:28px 0 20px 0;">
                <div style="height:1px;line-height:1px;font-size:1px;background:${BRAND.rule};">&nbsp;</div>
              </td>
            </tr>

            <!-- Safety footer -->
            <tr>
              <td style="padding:0 4px 24px 4px;">
                <p style="margin:0;font-family:${BRAND.sans};font-size:13px;line-height:1.55;color:${BRAND.ink3};">
                  Hindi ikaw ang humiling nito? Balewalain mo na lang ang email — walang ibang gagawin. Walang account na mabubukas hangga't hindi mo pinindot ang link.
                </p>
              </td>
            </tr>

            <!-- Brand footer -->
            <tr>
              <td style="padding:8px 4px 0 4px;border-top:1px solid ${BRAND.rule};">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="padding:20px 0 0 0;">
                      <div style="font-family:${BRAND.serif};font-size:18px;line-height:1;letter-spacing:-0.01em;color:${BRAND.ink};">
                        San <em style="color:${BRAND.accent};font-style:italic;">Sasakay</em>.
                      </div>
                      <div style="margin-top:8px;font-family:${BRAND.mono};font-size:11px;line-height:1.5;letter-spacing:0.04em;color:${BRAND.ink3};">
                        Para sa bawat Pilipinong umuuwi.
                      </div>
                      <div style="margin-top:14px;font-family:${BRAND.mono};font-size:10px;line-height:1.5;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.ink3};">
                        © ${year} San Sasakay
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  try {
    await mailer.send({ to: email, subject, text, html });
  } catch (err) {
    logger.error({ err, provider: env.EMAIL_PROVIDER }, "magic-link send failed");
    throw err;
  }
}
