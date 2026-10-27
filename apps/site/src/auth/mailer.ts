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

/** POST one email to Resend's HTTP API (no SDK dependency; uses global fetch).
 *  `baseUrl` is configurable so the production image can be smoke-tested against
 *  a fake Resend. */
/** A failed send. `status` is the mail API's HTTP status, or null when it
 *  couldn't be reached (network error, timeout). A 4xx means this message will
 *  never be accepted (bad address, refused); a 5xx or null may work later. */
export class MailError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? "email send failed (unreachable)" : `email send failed (${status})`);
  }
}

/** Under the 8 s shutdown deadline, so a hung mail API can't hold a drain open. */
const SEND_TIMEOUT_MS = 5_000;

/** One attachment Resend fetches itself from `path` (a URL it can reach). */
export interface ResendAttachment {
  filename: string;
  path: string;
  content_type?: string;
  content_id?: string;
}

/** The subset of Resend's send-email body this server uses. */
export interface ResendEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  reply_to?: string;
  headers?: Record<string, string>;
  attachments?: ResendAttachment[];
  /** Echoed back on bounce and complaint events, so feedback can be told apart. */
  tags?: { name: string; value: string }[];
}

export async function resendPost(baseUrl: string, apiKey: string, email: ResendEmail): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(email),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    throw new MailError(null);
  }
  // why: never include the response body — it can echo the address or key
  if (!res.ok) throw new MailError(res.status);
}

/** Prod mailer — Resend HTTP API. */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly baseUrl: string = "https://api.resend.com",
  ) {}

  async send(to: string, url: string): Promise<void> {
    await resendPost(this.baseUrl, this.apiKey, {
      from: this.from,
      to,
      subject: "Your Skovern sign-in link",
      text:
        `Here's your sign-in link. It works once and expires in 15 minutes:

` +
        `${url}

` +
        `Didn't ask to sign in? You can safely ignore this.`,
    });
  }
}
