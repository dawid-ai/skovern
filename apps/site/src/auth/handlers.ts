import type { AuthService } from "./service.js";

// Framework-agnostic handlers: pure (parsedBody) -> {status, body}. A Next.js
// route handler wraps each in one line when the HTTP layer lands; keeping them
// here means the product surface is testable without standing up a server.
export interface HttpResult {
  status: number;
  body: unknown;
  /** Defaults to application/json (body is JSON-stringified). Set to
   *  text/html or text/plain to send `body` as a raw string. */
  contentType?: string;
  /** Extra response headers (e.g. WWW-Authenticate on a 401). */
  headers?: Record<string, string>;
}

function readString(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

export async function handleRequestLink(service: AuthService, body: unknown): Promise<HttpResult> {
  const email = readString(body, "email");
  // Always the same 200 — never reveal whether the address is known.
  if (email) await service.requestMagicLink(email);
  return {
    status: 200,
    body: { ok: true, message: "If that email works, a sign-in link is on its way." },
  };
}

export async function handleVerify(service: AuthService, body: unknown): Promise<HttpResult> {
  const token = readString(body, "token");
  const session = token ? await service.verifyMagicLink(token) : null;
  if (!session) {
    return { status: 401, body: { ok: false, message: "That link didn't work. Ask for a new one." } };
  }
  return { status: 200, body: { ok: true, session: session.token, ogNumber: session.ogNumber } };
}
