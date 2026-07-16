import { ConsoleMailer, type Mailer } from "./mailer.js";
import { AuthStore } from "./store.js";
import { createOpaqueToken, parseToken } from "./tokens.js";

export interface Session {
  /** Opaque bearer token to hand back to the client. */
  token: string;
  accountId: string;
  ogNumber: number;
  email: string;
}

export interface AuthConfig {
  /** Base URL the magic link points at, e.g. https://skovern.org */
  appUrl: string;
  tokenTtlMinutes?: number;
  sessionTtlDays?: number;
}

// Deliberately strict: format only, no MX/deliverability guessing.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return EMAIL.test(email) ? email : null;
}

export class AuthService {
  private readonly tokenTtl: number;
  private readonly sessionTtl: number;

  constructor(
    private readonly store: AuthStore,
    private readonly mailer: Mailer,
    private readonly config: AuthConfig,
  ) {
    this.tokenTtl = config.tokenTtlMinutes ?? 15;
    this.sessionTtl = config.sessionTtlDays ?? 30;
  }

  /**
   * Send a sign-in link. Behaves identically whether or not the email already
   * has an account (accounts are created on verify, not here), so it leaks no
   * signal about who is registered.
   */
  async requestMagicLink(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    if (!email) return;
    const token = createOpaqueToken();
    await this.store.insertMagicToken({
      id: token.id,
      secretHash: token.secretHash,
      email,
      ttlMinutes: this.tokenTtl,
    });
    const url = `${this.config.appUrl}/auth/verify?token=${encodeURIComponent(token.full)}`;
    await this.mailer.send(email, url);
  }

  /** Resolve a bearer session token to its account (id + email), or null if
   *  it's not a live session. Used to guard authenticated routes (e.g. DM). */
  async validateSession(fullToken: string): Promise<{ accountId: string; email: string } | null> {
    const parsed = parseToken(fullToken);
    if (!parsed) return null;
    return this.store.validateSession(parsed.id, parsed.secret);
  }

  /** Redeem a magic link: create/find the account and issue a session. */
  async verifyMagicLink(fullToken: string): Promise<Session | null> {
    const parsed = parseToken(fullToken);
    if (!parsed) return null;
    const email = await this.store.consumeMagicToken(parsed.id, parsed.secret);
    if (!email) return null;
    const account = await this.store.upsertAccount(email);
    const session = createOpaqueToken();
    await this.store.createSession(account.id, session, this.sessionTtl);
    return {
      token: session.full,
      accountId: account.id,
      ogNumber: account.ogNumber,
      email: account.email,
    };
  }
}

export { AuthStore, ConsoleMailer };
