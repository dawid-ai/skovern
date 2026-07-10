import { lookup } from "node:dns/promises";
import net from "node:net";

// The real `fetch` a skill gets, with its OWN SSRF defense — it does NOT trust the
// broker's https-or-loopback guard; both layers must independently agree. Pragmatic
// slice (contract 012b): https-only, block resolved private/link-local/loopback/
// metadata ranges, reject decimal/hex/octal IP encodings. DEFERRED to a pre-community
// hardening loop: DNS-rebinding IP-pinning through the socket + per-redirect re-check.

const FETCH_TIMEOUT_MS = 10_000;

export interface FetchUrlOptions {
  /** DEV/TEST seam only: permit http + loopback so the e2e can hit a local mock.
   *  Default (production) is false → https-only, loopback blocked. */
  allowLoopback?: boolean;
}

function isLoopbackHostname(h: string): boolean {
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

// An IPv4 literal written in a non-dotted-decimal form (decimal `2130706433`, hex
// `0x7f000001`, octal `0177.0.0.1`, or shorthand `127.1`). WHATWG URL silently
// canonicalizes these, so we reject the *encoded form* up front rather than let a
// tricky spelling of a public IP slip past a reader's eye.
function isEncodedIpv4(rawHost: string): boolean {
  if (rawHost.length === 0) return false;
  if (/^[0-9]+$/.test(rawHost)) return true; // pure decimal, e.g. 2130706433
  if (/0x/i.test(rawHost)) return true; // hex, e.g. 0x7f.0x0.0x0.0x1
  const parts = rawHost.split(".");
  const numeric = parts.every((p) => /^[0-9]+$/.test(p));
  if (numeric && parts.length !== 4) return true; // shorthand, e.g. 127.1 or 1.2.3.4.5
  if (parts.some((p) => /^0[0-9]+$/.test(p))) return true; // octal octet, e.g. 0177
  return false;
}

function toParts(ip: string): number[] {
  return ip.split(".").map((n) => parseInt(n, 10));
}

// Block the ranges a skill has no business reaching from an "internet" grant:
// loopback, private, link-local (incl. the 169.254.169.254 cloud-metadata trap),
// unspecified, and IPv6 equivalents (ULA, link-local, IPv4-mapped).
function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const [a, b] = toParts(ip);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 172 && b! >= 16 && b! <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local + metadata
    if (a === 100 && b! >= 64 && b! <= 127) return true; // CGNAT
    return false;
  }
  if (kind === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd")) return true; // link-local + ULA
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (mapped) return isBlockedIp(mapped[1]!);
    return false;
  }
  return true; // not a recognizable IP → refuse rather than guess
}

export function createFetchUrl(opts: FetchUrlOptions = {}): (url: string) => Promise<string> {
  const allowLoopback = opts.allowLoopback === true;

  return async function fetchUrl(url: string): Promise<string> {
    const u = new URL(url); // throws on garbage → surfaces as a failed fetch
    const loopback = allowLoopback && isLoopbackHostname(u.hostname);

    if (u.protocol !== "https:" && !loopback) {
      throw new Error("unsafe-scheme");
    }

    // Reject the encoded-IP spellings before trusting the normalized hostname.
    const rawHost = u.hostname.replace(/^\[|\]$/g, "");
    if (isEncodedIpv4(rawHost)) throw new Error("encoded-ip");

    // Resolve to the actual addresses and range-check every one. A literal IP is
    // checked directly; a name is resolved (pragmatic — the socket may still race a
    // rebind; that's the deferred hardening item).
    const targets = net.isIP(rawHost) ? [rawHost] : (await lookup(rawHost, { all: true })).map((r) => r.address);
    for (const ip of targets) {
      if (isBlockedIp(ip) && !(allowLoopback && (ip === "127.0.0.1" || ip === "::1"))) {
        throw new Error("blocked-ip");
      }
    }

    // redirect:"error" so a 3xx can't bounce us to a private host un-rechecked
    // (per-redirect re-validation is the deferred hardening item).
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    // ponytail: no response-size ceiling yet; v1 skills are curated. Add a byte cap
    // (stream + abort) before untrusted/community plugins.
    return await res.text();
  };
}
