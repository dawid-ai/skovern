export interface Mailer {
  /** Deliver a magic-link email. `url` is single-use and short-lived. */
  send(to: string, url: string): Promise<void>;
}

/** Dev/test mailer — records and prints the link instead of sending. */
export class ConsoleMailer implements Mailer {
  public readonly sent: { to: string; url: string }[] = [];

  async send(to: string, url: string): Promise<void> {
    this.sent.push({ to, url });
    // The full link lives in `sent` for dev tooling/tests to read; the log line
    // itself never carries a full token or address (CLAUDE.md: never log those).
    const domain = to.slice(to.indexOf("@") + 1);
    const id = new URL(url).searchParams.get("token")?.split(".")[0] ?? "?";
    console.log(`[magic-link] queued for …@${domain} (token ${id.slice(0, 6)}…)`);
  }
}

/**
 * Dev-only mailer for the standalone server: prints the FULL magic link so you
 * can copy it into the app. This is the dev *delivery* channel (it replaces
 * email, like Rails/Django console mail) — never wired in a real deployment,
 * where ResendMailer sends and nothing logs the link.
 */
export class DevLinkMailer implements Mailer {
  async send(to: string, url: string): Promise<void> {
    console.log(`\n  Sign-in link for ${to}:\n  ${url}\n`);
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
