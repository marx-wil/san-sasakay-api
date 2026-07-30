/**
 * Account-deletion confirmation email.
 * Same table-based / inline-style pattern as sendMagicLink.
 */

import { env } from "../config.js";
import { logger } from "./logger.js";
import { BRAND, mailer } from "./mail.js";

export async function sendAccountDeletionEmail(email: string, link: string): Promise<void> {
  const subject = "Kumpirmahin ang pag-delete ng account — San Sasakay";
  const ttlMinutes = Math.round(env.MAGIC_LINK_TTL_SECONDS / 60);
  const year = new Date().getFullYear();

  const text = [
    "San Sasakay",
    "",
    "Kumpirmahin ang pag-delete ng account",
    "",
    "May humiling na i-delete ang San Sasakay account na naka-link sa email na ito.",
    "Kapag pinindot mo ang link, permanenteng mabubura ang account, reports, points, at personal data mo. Hindi na ito mababawi.",
    "",
    link,
    "",
    `Mag-e-expire ang link na ito sa loob ng ${ttlMinutes} minuto.`,
    "",
    "Hindi ikaw ang humiling nito? Balewalain mo na lang ang email — walang mabubura hangga't hindi mo pinindot ang link.",
    "",
    "—",
    "Para sa bawat Pilipinong umuuwi.",
    `© ${year} San Sasakay`,
  ].join("\n");

  const preheader = `Kumpirmahin ang pag-delete. Mag-e-expire sa ${ttlMinutes} minuto.`;

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
            <tr>
              <td style="padding:0 0 28px 0;">
                <span style="font-family:${BRAND.serif};font-size:26px;line-height:1;letter-spacing:-0.01em;color:${BRAND.ink};">San <em style="color:${BRAND.accent};font-style:italic;">Sasakay</em>.</span>
              </td>
            </tr>

            <tr>
              <td style="background:${BRAND.card};border:1px solid ${BRAND.rule};border-radius:2px;padding:36px 32px 32px 32px;">
                <h1 style="margin:0 0 16px 0;font-family:${BRAND.serif};font-size:28px;line-height:1.2;font-weight:400;color:${BRAND.ink};letter-spacing:-0.01em;">
                  Kumpirmahin ang pag-<em style="color:${BRAND.accent};font-style:italic;">delete</em>.
                </h1>
                <p style="margin:0 0 16px 0;font-family:${BRAND.sans};font-size:15px;line-height:1.55;color:${BRAND.ink2};">
                  May humiling na i-delete ang San Sasakay account na naka-link sa email na ito.
                </p>
                <p style="margin:0 0 28px 0;font-family:${BRAND.sans};font-size:15px;line-height:1.55;color:${BRAND.ink2};">
                  Kapag pinindot mo ang button, permanenteng mabubura ang account, reports, points, at personal data mo. Hindi na ito mababawi.
                </p>

                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px 0;">
                  <tr>
                    <td align="center" bgcolor="${BRAND.ink}" style="background:${BRAND.ink};border-radius:2px;">
                      <a href="${link}" style="display:inline-block;padding:14px 28px;font-family:${BRAND.mono};font-size:13px;line-height:1;letter-spacing:0.04em;text-transform:uppercase;color:#ffffff;text-decoration:none;border:1px solid ${BRAND.ink};border-radius:2px;">
                        I-delete ang account
                      </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:0 0 8px 0;font-family:${BRAND.sans};font-size:13px;line-height:1.5;color:${BRAND.ink3};">
                  Hindi gumagana ang button? Kopyahin ang link na ito:
                </p>
                <p style="margin:0 0 24px 0;font-family:${BRAND.mono};font-size:12px;line-height:1.5;color:${BRAND.ink2};word-break:break-all;">
                  <a href="${link}" style="color:${BRAND.ink2};text-decoration:underline;">${link}</a>
                </p>

                <p style="margin:0;font-family:${BRAND.mono};font-size:11px;line-height:1;letter-spacing:0.06em;text-transform:uppercase;color:${BRAND.ink3};">
                  <span style="display:inline-block;padding:6px 10px;border:1px solid ${BRAND.rule};border-radius:2px;background:${BRAND.bg};">
                    Mag-e-expire sa ${ttlMinutes} minuto
                  </span>
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:28px 0 20px 0;">
                <div style="height:1px;line-height:1px;font-size:1px;background:${BRAND.rule};">&nbsp;</div>
              </td>
            </tr>

            <tr>
              <td style="padding:0 4px 24px 4px;">
                <p style="margin:0;font-family:${BRAND.sans};font-size:13px;line-height:1.55;color:${BRAND.ink3};">
                  Hindi ikaw ang humiling nito? Balewalain mo na lang ang email — walang mabubura hangga't hindi mo pinindot ang link.
                </p>
              </td>
            </tr>

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
    logger.error({ err, provider: env.EMAIL_PROVIDER }, "account-deletion email send failed");
    throw err;
  }
}
