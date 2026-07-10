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

// Block the ranges a skill has no business reaching from an "internet" grant:
// loopback, private, link-local (incl. the 169.254.169.254 cloud-metadata trap),
// unspecified, CGNAT, and the IPv6 equivalents. Built on stdlib net.BlockList so the
// fiddly IP math — CIDR boundaries AND IPv4-mapped IPv6 in every serialization
// (::ffff:7f00:1, ::ffff:127.0.0.1) — is handled correctly, not hand-rolled.
function buildBlockList(): net.BlockList {
  const bl = new net.BlockList();
  bl.addSubnet("0.0.0.0", 8, "ipv4"); // unspecified / "this network"
  bl.addSubnet("10.0.0.0", 8, "ipv4");
  bl.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
  bl.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
  bl.addSubnet("169.254.0.0", 16, "ipv4"); // link-local + metadata (169.254.169.254)
  bl.addSubnet("172.16.0.0", 12, "ipv4");
  bl.addSubnet("192.168.0.0", 16, "ipv4");
  bl.addAddress("::1", "ipv6"); // loopback
  bl.addAddress("::", "ipv6"); // unspecified
  bl.addSubnet("fe80::", 10, "ipv6"); // link-local
  bl.addSubnet("fc00::", 7, "ipv6"); // ULA
  bl.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64 (embeds a v4 target) — block wholesale
  // IPv4-mapped (::ffff:0:0/96) needs no rule: BlockList checks it against the v4 rules.
  return bl;
}
const BLOCKED = buildBlockList();

function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 0) return true; // not a recognizable IP → refuse rather than guess
  return BLOCKED.check(ip, kind === 6 ? "ipv6" : "ipv4");
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
