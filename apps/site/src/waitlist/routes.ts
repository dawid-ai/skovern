import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpResult } from "../auth/handlers.js";
import { clientIp, readForm, readJson, send } from "../http.js";
import { LIMITS, limitFailures, type Limit, type RateLimiter } from "../server/rate-limit.js";
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
const FOREIGN_ORIGIN: HttpResult = { status: 403, body: { ok: false, message: "This form only works on skovern.com." } };
const UNSUPPORTED: HttpResult = { status: 415, body: { ok: false, message: "Send JSON." } };
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
    // A browser always sends Origin on a cross-site POST. If one is there, it
    // must be ours, for the JSON calls and the no-JS form alike, so no other
    // site can post signups (and welcome emails) through a visitor's browser.
    const origin = req.headers.origin;
    if (origin !== undefined && !ctx.corsOrigins.includes(origin)) return reply(FOREIGN_ORIGIN);
    // JSON only, except the no-JS signup form. Anything else (text/plain, the
    // "simple" type a cross-site form or beacon can send) is refused.
    const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    const form = join && type === "application/x-www-form-urlencoded";
    if (!form && type !== "application/json") return reply(UNSUPPORTED, cors);
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
    let form: URLSearchParams;
    try {
      form = await readForm(req);
    } catch {
      return reply(BAD_REQUEST);
    }
    // The confirm page posts `t` in the body; RFC 8058 one-click posts to the link
    // itself. Only dead links count against the limit, so a mail provider's
    // one-click unsubscribes (many people, one address) are never refused.
    const token = form.get("t") ?? query.get("t");
    return reply(
      await limitFailures(
        ctx.limiter,
        `remove-fail:${clientIp(req, ctx.trustProxy)}`,
        LIMITS.waitlistRemove,
        () => handleRemove(ctx.deps, token),
        (r) => r.status !== 200,
      ),
    );
  }

  if (path === "/admin/waitlist" || path === "/admin/waitlist.csv") {
    if (method !== "GET") return reply(USE("GET"));
    const auth = req.headers.authorization ?? null;
    return reply(
      await limitFailures(
        ctx.limiter,
        `admin-fail:${clientIp(req, ctx.trustProxy)}`,
        LIMITS.adminFail,
        () =>
          path === "/admin/waitlist"
            ? handleAdminWaitlist(ctx.deps.store, ctx.adminToken, auth)
            : handleAdminWaitlistCsv(ctx.deps.store, ctx.adminToken, auth),
        (r) => r.status === 401,
      ),
    );
  }
  return false;
}
