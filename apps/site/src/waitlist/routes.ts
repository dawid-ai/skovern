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

/** No-JS fallback: the plain HTML form posts here, so send the person back to
 *  the site. Only a real 201 goes to the done page; every refusal (bad input,
 *  429, bad body) goes to the "didn't go through" page. */
export function formRedirect(siteUrl: string, result: HttpResult): HttpResult {
  const b = result.body as { number?: unknown; field?: unknown };
  const why = result.status === 429 ? "busy" : typeof b.field === "string" ? b.field : "form";
  const to =
    result.status === 201 && typeof b.number === "number"
      ? `${siteUrl}/waitlist/done/?n=${b.number}`
      : `${siteUrl}/waitlist/oops/?error=${encodeURIComponent(why)}`;
  return { status: 303, body: "", contentType: "text/plain", headers: { location: to, "cache-control": "no-store" } };
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
    const form = join && isFormPost(req);
    const over = limited(ctx, req, join ? "waitlist" : "details", join ? LIMITS.waitlist : LIMITS.waitlistDetails);
    let result: HttpResult;
    if (over) {
      result = over;
    } else {
      let body: unknown;
      try {
        body = form ? Object.fromEntries(await readForm(req)) : await readJson(req);
        result = join ? await handleJoin(ctx.deps, body) : await handleDetails(ctx.deps, body);
      } catch (err) {
        const badBody = err instanceof SyntaxError || (err as Error).message === "body too large";
        // A JSON caller gets the server's generic 500; a no-JS form still lands on a real page.
        if (!badBody && !form) throw err;
        if (!badBody) console.error("[waitlist] form signup failed:", (err as Error).message);
        result = badBody ? BAD_REQUEST : { status: 500, body: { ok: false } };
      }
    }
    if (form) return reply(formRedirect(ctx.siteUrl, result));
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
