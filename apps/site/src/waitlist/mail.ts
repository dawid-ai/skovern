import { resendPost } from "../auth/mailer.js";

// The one email the waitlist sends: a welcome with the person's place in line
// and a one-click remove link (CAN-SPAM / CASL). Plain text, no tracking.

export interface Welcome {
  name: string;
  number: number;
  removeUrl: string;
}

export interface WelcomeMailer {
  sendWelcome(to: string, w: Welcome): Promise<void>;
}

export function welcomeText(w: Welcome): { subject: string; text: string } {
  return {
    subject: `You're #${w.number} on the Skovern waitlist`,
    text:
      `Hi ${w.name},\n\n` +
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
