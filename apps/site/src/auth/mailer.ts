export interface Mailer {
  /** Deliver a magic-link email. `url` is single-use and short-lived. */
  send(to: string, url: string): Promise<void>;
}

/** Dev/test mailer — records and prints the link instead of sending. */
export class ConsoleMailer implements Mailer {
  public readonly sent: { to: string; url: string }[] = [];

  async send(to: string, url: string): Promise<void> {
    this.sent.push({ to, url });
    console.log(`[magic-link] ${to} -> ${url}`);
  }
}

/** Prod mailer — Resend HTTP API (no SDK dependency; uses global fetch). */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(to: string, url: string): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to,
        subject: "Your Deskhand sign-in link",
        text:
          `Here's your sign-in link. It works once and expires in 15 minutes:\n\n` +
          `${url}\n\n` +
          `Didn't ask to sign in? You can safely ignore this.`,
      }),
    });
    if (!res.ok) {
      // why: never include the response body — it can echo the address or key
      throw new Error(`email send failed (${res.status})`);
    }
  }
}
