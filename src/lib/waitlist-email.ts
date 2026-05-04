/**
 * "You're on the waitlist" confirmation email.
 *
 * Mirrors the structure of sendMagicLink: table-based layout, every style
 * inline, tokens from src/lib/mail.ts. The visual rhythm matches the
 * magic-link email so the two read like the same brand.
 *
 * No CTA button — there's nothing for the user to do yet. Just a receipt
 * + a small piece of brand voice. We send a single confirmation; we do
 * NOT broadcast a launch email later (storage is hash-only by design).
 */

import { env } from "../config.js";
import { logger } from "./logger.js";
import { BRAND, mailer } from "./mail.js";

export async function sendWaitlistConfirmation(email: string, position?: number): Promise<void> {
  const subject = "Nasa waitlist ka na — San Sasakay";
  const year = new Date().getFullYear();

  // Optional "you're #143" line. We pass the position from the route when
  // we have it; otherwise the line is omitted entirely (no awkward "#?").
  const positionLine = position
    ? `Ikaw ang #${position} sa listahan.`
    : "Sasabihan ka namin pagdating ng panahon.";

  const text = [
    "San Sasakay",
    "",
    "Nasa waitlist ka na",
    "",
    "Salamat sa pagsali. Bago lumabas sa publiko ang Android app, " +
      "ikaw ay isa sa mga unang aabisuhan.",
    "",
    positionLine,
    "",
    "Ano ang susunod?",
    "Wala. Magpahinga ka muna. Pag handa na, padadalhan ka namin ng " +
      "imbitasyon — at sa unang sign-in mo, may +200 Sasakay Points " +
      "kang naghihintay. Welcome bonus, regalo sa pagiging maaga.",
    "",
    "—",
    "Para sa bawat Pilipinong umuuwi.",
    `© ${year} San Sasakay`,
  ].join("\n");

  // Hidden preheader text — what most inbox previews show beside the
  // subject line. Padded with whitespace so the client doesn't trail
  // it with the visible body text.
  const preheader = "Salamat. Aabisuhan ka namin bago tayo mag-launch.";

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
                  Nasa <em style="color:${BRAND.accent};font-style:italic;">waitlist</em> ka na.
                </h1>
                <p style="margin:0 0 20px 0;font-family:${BRAND.sans};font-size:15px;line-height:1.55;color:${BRAND.ink2};">
                  Salamat sa pagsali. Bago lumabas sa publiko ang Android app,
                  ikaw ay isa sa mga unang aabisuhan.
                </p>

                <!-- Position chip (only when we have a number) -->
                ${
                  position
                    ? `<p style="margin:0 0 28px 0;font-family:${BRAND.mono};font-size:11px;line-height:1;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.ink3};">
                  <span style="display:inline-block;padding:6px 10px;border:1px solid ${BRAND.rule};border-radius:2px;background:${BRAND.bg};">
                    Ikaw ang #${position} sa listahan
                  </span>
                </p>`
                    : `<p style="margin:0 0 28px 0;font-family:${BRAND.sans};font-size:14px;line-height:1.55;color:${BRAND.ink2};">
                  Sasabihan ka namin pagdating ng panahon.
                </p>`
                }

                <!-- Divider -->
                <div style="height:1px;line-height:1px;font-size:1px;background:${BRAND.rule};margin:0 0 24px 0;">&nbsp;</div>

                <h2 style="margin:0 0 10px 0;font-family:${BRAND.serif};font-size:18px;line-height:1.3;font-weight:400;color:${BRAND.ink};">
                  Ano ang susunod?
                </h2>
                <p style="margin:0 0 16px 0;font-family:${BRAND.sans};font-size:14px;line-height:1.55;color:${BRAND.ink2};">
                  Wala. Magpahinga ka muna. Pag handa na, padadalhan ka namin
                  ng imbitasyon — at sa unang sign-in mo, may
                  <strong style="color:${BRAND.ink};font-weight:600;">+200 Sasakay Points</strong>
                  kang naghihintay. Welcome bonus, regalo sa pagiging maaga.
                </p>
              </td>
            </tr>

            <!-- Divider -->
            <tr>
              <td style="padding:28px 0 20px 0;">
                <div style="height:1px;line-height:1px;font-size:1px;background:${BRAND.rule};">&nbsp;</div>
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
    logger.error({ err, provider: env.EMAIL_PROVIDER }, "waitlist confirmation send failed");
    throw err;
  }
}
