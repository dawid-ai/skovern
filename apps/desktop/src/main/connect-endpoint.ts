// Pure endpoint helpers for the "connect your own brain by address" lane (loop 044) — kept out of
// the electron-coupled local.ts so the trust-boundary logic (what's a valid address, what counts
// as OFF this computer) is unit-testable on its own.

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Normalize a typed address into an http origin: prepend `http://` if no scheme, confirm it
 *  parses to an http(s) host. Returns null if it can't be made a valid http(s) URL — the check at
 *  the trust boundary before any fetch. Drops any path/query/credentials (origin only). */
export function normalizeEndpoint(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A non-http URL scheme (with OR without `//`) must never be massaged into an http host — reject
  // it outright so `file:/etc/passwd` can't normalize to `http://file`. host:port has no scheme.
  if (/^(file|ftp|ftps|ws|wss|data|blob|javascript|mailto|about|view-source):/i.test(trimmed)) return null;
  // Prepend http:// ONLY when there's no scheme at all — never when the input already carries one,
  // so a `file://` / `ws://` keeps its scheme and gets rejected below instead of being mangled into
  // a valid-looking `http://file`. A bare `host:port` has no `scheme://` and gets the http:// added.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `http://${trimmed}`;
  try {
    const u = new URL(withScheme);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Is this endpoint OFF this computer? A loopback host stays on the machine (no egress); anything
 *  else leaves it (→ warning + receipts + the relaxed guard). An unparseable endpoint reads as
 *  on-box (it won't connect anyway). NB: does NOT consult the dev force-offbox seam — that lives in
 *  local.ts's `isOffBox`, which layers the seam over this pure check. */
export function hostIsOffBox(endpoint: string): boolean {
  try {
    return !LOOPBACK_HOSTS.has(new URL(endpoint).hostname.toLowerCase());
  } catch {
    return false;
  }
}
