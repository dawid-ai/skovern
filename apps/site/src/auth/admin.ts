import type { HttpResult } from "./handlers.js";
import { secretMatches, sha256 } from "./tokens.js";

// Shared guard for the founder's admin surface (DM thread, news publish). One
// copy of the auth check, not one per route — a security compare you don't want
// drifting between call sites. Uses HTTP Basic so a browser prompts natively;
// the password half is the admin token, compared constant-time.

const UNAUTHORIZED: HttpResult = {
  status: 401,
  body: "Unauthorized",
  contentType: "text/plain",
  headers: { "www-authenticate": 'Basic realm="Skovern admin"' },
};

/** Extract the password from `Authorization: Basic base64(user:pass)`. */
function basicPassword(header: string | null): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon < 0 ? decoded : decoded.slice(colon + 1);
  } catch {
    return null;
  }
}

/**
 * Returns null if the request carries the right admin token, else the 401 to
 * send back. A null/empty adminToken disables the surface entirely (the compare
 * never runs), so a missing env var can't leave admin wide open.
 */
export function requireAdmin(adminToken: string | null, authHeader: string | null): HttpResult | null {
  if (!adminToken) return UNAUTHORIZED;
  const provided = basicPassword(authHeader);
  if (!provided || !secretMatches(provided, sha256(adminToken))) return UNAUTHORIZED;
  return null;
}
