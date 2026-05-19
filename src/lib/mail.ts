/**
 * Shared mail dispatch + brand tokens.
 *
 * Single source of truth for the SES (prod) / Mailpit (dev) provider switch
 * and the inline brand styles that templates use. Email clients don't
 * honour CSS variables (and many strip <style> blocks entirely), so every
 * value below is meant to be baked inline at template build time.
 *
 * Templates that send mail import { mailer, BRAND } from here.
 */

import { Resend } from "resend";
import { env } from "../config.js";

export interface MailProvider {
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

class ResendProvider implements MailProvider {
  private resend: Resend;

  constructor() {
    if (!env.RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is required when EMAIL_PROVIDER=resend");
    }
    this.resend = new Resend(env.RESEND_API_KEY);
  }

  async send(args: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<void> {
    const { error } = await this.resend.emails.send({
      from: env.EMAIL_FROM,
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
    });
    if (error) {
      throw new Error(`Resend failed: ${error.message}`);
    }
  }
}

function stripAddress(emailFrom: string): string {
  // "San Sasakay <no-reply@x>" -> "no-reply@x"
  const m = emailFrom.match(/<([^>]+)>/);
  return m?.[1] ?? emailFrom;
}

export const mailer: MailProvider =
  env.EMAIL_PROVIDER === "resend" ? new ResendProvider() : new MailpitProvider();

/**
 * Brand tokens, mirrored from landing/src/app/globals.css. Email clients
 * don't honour CSS variables (and many strip <style> blocks entirely), so
 * every value gets baked into inline styles at template build time. If
 * the landing's tokens shift, mirror them here.
 */
export const BRAND = {
  bg: "#fafaf8", // page canvas
  card: "#f3f3f0", // hero card
  ink: "#0e0e0e", // primary text + button bg
  ink2: "#3a3a3a", // body text
  ink3: "#888888", // metadata / footer
  rule: "#e0e0e0", // dividers
  accent: "#e8410a", // italic accent + chip border
  // Web-safe fallbacks. Instrument Serif and Geist Mono won't load reliably
  // in email clients; Georgia and the system mono stack are the closest
  // editorial / monospace pair that ships everywhere.
  serif: "Georgia, 'Times New Roman', Times, serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
} as const;
