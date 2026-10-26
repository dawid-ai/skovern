import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpResult } from "../auth/handlers.js";
import { clientIp, isFormPost, readForm, readJson, send } from "../http.js";
import { LIMITS, type Limit, type RateLimiter } from "../server/rate-limit.js";
import { handleAdminWaitlist, handleAdminWaitlistCsv } from "./admin.js";
import { handleDetails, handleJoin, handleRemove, handleRemovePage, type WaitlistDeps } from "./handlers.js";

// HTTP routing for the waitlist surface: the two public JSON endpoints (CORS +
// per-IP limits), the remove page, and the founder admin view.

export interface WaitlistRouteContext {
  deps: WaitlistDeps;
  limiter: RateLimiter;
  trustProxy: boolean;
  corsOrigins: string[];
  adminToken: string | null;
  /** Marketing site base, for the no-JS form redirect. */
  siteUrl: string;
}

const BAD_REQUEST: HttpResult = { status: 400, body: { ok: false, message: "Bad request." } };
const USE = (m: string): HttpResult => ({ status: 405, body: { ok: false, message: `Use ${m}.` } });

/** CORS headers for an allowed browser origin; none at all for anyone else. */
export function corsHeaders(req: IncomingMessage, allowed: string[]): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function limited(ctx: WaitlistRouteContext, req: IncomingMessage, bucket: string, limit: Limit): HttpResult | null {
  const key = `${bucket}:${clientIp(req, ctx.trustProxy)}`;
  if (ctx.limiter.take(key, limit)) return null;
  return {
    status: 429,
    body: { ok: false, message: "Lots of tries from here. Wait a few minutes and try again." },
    headers: { "retry-after": String(ctx.limiter.retryAfter(key)) },
  };
}

/** Handles the route and returns true, or returns false if the path isn't ours. */
export async function routeWaitlist(
  ctx: WaitlistRouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const query = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
  const reply = (result: HttpResult, headers?: Record<string, string>): true => {
    send(res, result, headers);
    return true;
  };

  if (path === "/api/waitlist" || path === "/api/waitlist/details") {
    const cors = corsHeaders(req, ctx.corsOrigins);
    if (method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return true;
    }
    if (method !== "POST") return reply(USE("POST"), cors);
    const join = path === "/api/waitlist";
    const over = limited(ctx, req, join ? "waitlist" : "details", join ? LIMITS.waitlist : LIMITS.waitlistDetails);
    if (over) return reply(over, cors);
    const form = join && isFormPost(req);
    let body: unknown;
    try {
      body = form ? Object.fromEntries(await readForm(req)) : await readJson(req);
    } catch {
      return reply(BAD_REQUEST, cors);
    }
    const result = join ? await handleJoin(ctx.deps, body) : await handleDetails(ctx.deps, body);
    if (form) {
      // No-JS fallback: the plain HTML form posts here; send the person back to the site.
      const b = result.body as { number?: number; field?: string };
      const to =
        result.status === 201
          ? `${ctx.siteUrl}/waitlist/done/?n=${b.number ?? ""}`
          : `${ctx.siteUrl}/waitlist/done/?error=${encodeURIComponent(b.field ?? "form")}`;
      return reply({ status: 303, body: "", contentType: "text/plain", headers: { location: to } });
    }
    return reply(result, cors);
  }

  if (path === "/waitlist/remove") {
    if (method === "GET") return reply(await handleRemovePage(ctx.deps, query.get("t")));
    if (method !== "POST") return reply(USE("GET or POST"));
    const over = limited(ctx, req, "remove", LIMITS.waitlistRemove);
    if (over) return reply(over);
    let form: URLSearchParams;
    try {
      form = await readForm(req);
    } catch {
      return reply(BAD_REQUEST);
    }
    // The confirm page posts `t` in the body; RFC 8058 one-click posts to the link itself.
    return reply(await handleRemove(ctx.deps, form.get("t") ?? query.get("t")));
  }

  if (path === "/admin/waitlist" || path === "/admin/waitlist.csv") {
    if (method !== "GET") return reply(USE("GET"));
    const auth = req.headers.authorization ?? null;
    const result =
      path === "/admin/waitlist"
        ? await handleAdminWaitlist(ctx.deps.store, ctx.adminToken, auth)
        : await handleAdminWaitlistCsv(ctx.deps.store, ctx.adminToken, auth);
    return reply(result);
  }
  return false;
}
