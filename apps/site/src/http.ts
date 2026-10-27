import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpResult } from "./auth/handlers.js";

// Shared wire helpers for the stdlib HTTP server: bounded body reads, one
// response writer, and the client-IP rule the rate limiter keys on.

// Every request body here is a few hundred bytes; cap hard so a flood can't buffer.
const MAX_BODY = 4096;

/** Read the whole body as UTF-8, refusing anything over `max` bytes. */
export async function readRawBody(req: IncomingMessage, max: number = MAX_BODY): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) throw new Error("body too large");
    chunks.push(buf);
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  return raw ? JSON.parse(raw) : {};
}

export async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readRawBody(req));
}

export function send(res: ServerResponse, result: HttpResult, extra?: Record<string, string>): void {
  const contentType = result.contentType ?? "application/json";
  res.writeHead(result.status, { "content-type": contentType, ...extra, ...result.headers });
  // Binary bodies (e.g. the PNG share card) go out untouched — String() would
  // corrupt them. Everything else is JSON unless a text content-type was set.
  if (Buffer.isBuffer(result.body)) {
    res.end(result.body);
    return;
  }
  if (result.status === 204) {
    res.end();
    return;
  }
  const payload =
    contentType === "application/json" ? JSON.stringify(result.body) : String(result.body);
  res.end(payload);
}

export function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

/**
 * The client address the rate limiter keys on. Behind Railway's edge, the proxy
 * APPENDS the real peer to X-Forwarded-For, so only the rightmost entry is
 * trustworthy; anything to its left is whatever the client chose to send. With
 * `trustProxy` off (no proxy in front), the header is ignored entirely.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const raw = req.headers["x-forwarded-for"];
    const header = Array.isArray(raw) ? raw.join(",") : raw;
    const rightmost = header?.split(",").pop()?.trim();
    if (rightmost) return limitKey(rightmost);
  }
  return limitKey(req.socket.remoteAddress ?? "unknown");
}

/**
 * The address a limit counts against. An IPv6 home or phone connection owns a
 * whole /64 and can rotate through it freely, so IPv6 is keyed on its first
 * four groups; an IPv4-mapped IPv6 address is keyed as plain IPv4.
 */
export function limitKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("%")[0]!.split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") && tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
