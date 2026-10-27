import { resendPost } from "../auth/mailer.js";

// The one email the waitlist sends: a welcome with the person's place in line
// and a one-click remove link (CAN-SPAM / CASL). Plain text, no tracking.

/** The `kind` tag on every welcome email; bounce events carry it back. */
export const WELCOME_TAG = "welcome";

export interface Welcome {
  name: string;
  number: number;
  removeUrl: string;
}

export interface WelcomeMailer {
  sendWelcome(to: string, w: Welcome): Promise<void>;
}

/** The greeting word: the first word of the name, skipping any word with a
 *  period in it, so nothing link-like reaches the email even if it slipped past
 *  the name rule. Null (so "Hi there") when nothing is left. */
export function greetingName(name: string): string | null {
  return name.split(/\s+/).find((word) => word !== "" && !word.includes(".")) ?? null;
}

export function welcomeText(w: Welcome): { subject: string; text: string } {
  const who = greetingName(w.name);
  return {
    subject: `You're #${w.number} on the Skovern waitlist`,
    text:
      `Hi ${who ?? "there"},\n\n` +
      `You're on the list. Your spot is #${w.number}.\n\n` +
      `Skovern is free AI for your shop, and you control what leaves your computer. ` +
      `We're letting people in a few at a time, Windows first. ` +
      `We'll email you when your invite is ready.\n\n` +
      `Talk soon,\nDawid, founder of Skovern\n\n` +
      `--\n` +
      `You got this because you joined the waitlist at skovern.com.\n` +
      `Changed your mind? Leave the list with one click: ${w.removeUrl}\n`,
  };
}

export class ResendWelcomeMailer implements WelcomeMailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly baseUrl: string,
  ) {}

  async sendWelcome(to: string, w: Welcome): Promise<void> {
    const { subject, text } = welcomeText(w);
    await resendPost(this.baseUrl, this.apiKey, {
      from: this.from,
      to,
      subject,
      text,
      // RFC 8058 one-click unsubscribe; mail clients show their own button.
      headers: {
        "List-Unsubscribe": `<${w.removeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      // Resend echoes this on bounce and complaint events (the bounce pause).
      tags: [{ name: "kind", value: WELCOME_TAG }],
    });
  }
}

/** Dev-only: prints the welcome (with its remove link) instead of sending.
 *  Never wired in production, where the config requires RESEND_API_KEY. */
export class DevWelcomeMailer implements WelcomeMailer {
  public readonly sent: { to: string; welcome: Welcome }[] = [];

  async sendWelcome(to: string, w: Welcome): Promise<void> {
    this.sent.push({ to, welcome: w });
    console.log(`\n  Waitlist welcome for ${to}: #${w.number}\n  Remove link: ${w.removeUrl}\n`);
  }
}
