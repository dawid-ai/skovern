import { createHmac, timingSafeEqual } from "node:crypto";

// Resend signs webhooks with Svix: an HMAC-SHA256 over `id.timestamp.body`,
// keyed with the base64 part of the `whsec_...` secret, sent as one or more
// space-separated `v1,<base64>` entries in `svix-signature`. Checked here
// without the svix package (docs.svix.com/receiving/verifying-payloads/how-manual).

/** A timestamp further than this from our clock, either way, is refused. */
export const TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

export type SvixVerdict = "ok" | "missing" | "stale" | "bad-signature";

/** The signature Svix would send for this message, base64. */
export function svixSign(key: Buffer, id: string, timestamp: string, body: string): string {
  return createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

/**
 * Check a webhook against the signing key. `body` must be the raw request body,
 * byte for byte. `now` is in milliseconds.
 */
export function verifySvix(key: Buffer, h: SvixHeaders, body: string, now: number = Date.now()): SvixVerdict {
  const { id, timestamp, signature } = h;
  if (!id || !timestamp || !signature) return "missing";
  if (id.length > 256 || !/^\d{1,12}$/.test(timestamp)) return "missing";
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return "stale";
  const expected = Buffer.from(svixSign(key, id, timestamp, body), "base64");
  for (const entry of signature.split(" ")) {
    const [version, sig] = entry.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return "ok";
  }
  return "bad-signature";
}
