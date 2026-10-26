import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { handleRequestLink, handleVerify, type HttpResult } from "./handlers.js";
import type { AuthService } from "./service.js";
import { handleAdminNews, handleNews } from "../news/handlers.js";
import type { NewsStore } from "../news/store.js";
import {
  handleAdminDm,
  handleAdminDmReply,
  handleDm,
  handleDmRead,
  handleDmThread,
  type DmDeps,
} from "../dm/handlers.js";
import { handlePublish, handlePublishVisibility, handleVisibilityPage } from "../publish/handlers.js";
import type { VisibilityStore } from "../publish/visibility-store.js";
import { bearer, clientIp, readForm, readJson, send } from "../http.js";
import { LIMITS, type RateLimiter } from "../server/rate-limit.js";
import { routeWaitlist, type WaitlistRouteContext } from "../waitlist/routes.js";

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

// CSRF guard for the Basic-auth admin POSTs. Basic auth is ambient (the browser
// re-sends cached creds), so a cross-origin form could ride them. A browser
// ALWAYS sends Origin on a cross-origin POST, so: if Origin/Referer is present
// it must match our host; a request with neither is a non-browser client
// (curl/server) and can't be a CSRF vector. Bearer-token routes don't need this.
function sameOriginOk(req: IncomingMessage): boolean {
  const source = req.headers.origin ?? req.headers.referer;
  if (!source) return true;
  try {
    return new URL(source).host === req.headers.host;
  } catch {
    return false;
  }
}

const BAD_ORIGIN: HttpResult = { status: 403, body: { ok: false, message: "Bad origin." } };

// The absolute public base for links + og:image. Prefer the configured origin;
// only fall back to the (spoofable) Host header for local dev, honoring a TLS
// proxy's forwarded scheme.
function resolveOrigin(req: IncomingMessage, publicOrigin: string | undefined): string {
  if (publicOrigin) return publicOrigin;
  const fwd = req.headers["x-forwarded-proto"];
  const proto = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0] ?? "http";
  return `${proto}://${req.headers.host ?? "127.0.0.1"}`;
}

/**
 * The tiny cloud API over Node's stdlib http — no framework. Exposes the
 * loop-002 handlers at POST /auth/request and /auth/verify. Returned as a
 * factory so tests (and a future dev runner) can start it in-process.
 */
export function startAuthServer(opts: {
  service: AuthService;
  news?: NewsStore;
  dm?: DmDeps;
  /** User-published AI Visibility results (loop 013b). */
  visibility?: VisibilityStore;
  /** Guards the founder admin surface (DM thread, news publish). Null = off. */
  adminToken?: string | null;
  /** Absolute public base (e.g. https://skovern.org) for og:image URLs. When
   *  set it wins over the request Host header, so a spoofed Host/proto can't be
   *  reflected into published pages. */
  publicOrigin?: string;
  port?: number;
  /** Bind address. 127.0.0.1 for dev; the container sets 0.0.0.0. */
  host?: string;
  /** Waitlist API, remove page, and admin view (loop 051). */
  waitlist?: WaitlistRouteContext;
  /** Per-IP limiter for /auth/request; shares the waitlist's proxy rule. */
  limiter?: RateLimiter;
  trustProxy?: boolean;
}): Promise<RunningServer> {
  const adminToken = opts.adminToken ?? null;
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? "GET";
        const path = (req.url ?? "").split("?")[0] ?? "";
        // Liveness for the platform health check. No database round-trip, so a
        // brief Postgres blip doesn't get the container killed mid-drain.
        if (path === "/healthz") {
          return send(res, { status: 200, body: { ok: true } }, { "cache-control": "no-store" });
        }
        if (opts.waitlist && (await routeWaitlist(opts.waitlist, req, res, path))) return;
        // Public news feed — GET only, no auth (readable without account).
        if (path === "/news" && opts.news) {
          if (method !== "GET") {
            return send(res, { status: 405, body: { ok: false, message: "Use GET." } });
          }
          return send(res, await handleNews(opts.news));
        }
        // Public published pages + OG cards, e.g. /u/news/<slug> or
        // /u/visibility/<id> [/og.png]. GET only, no auth (readable without account).
        if (path.startsWith("/u/")) {
          if (method !== "GET") {
            return send(res, { status: 405, body: { ok: false, message: "Use GET." } });
          }
          const origin = resolveOrigin(req, opts.publicOrigin);
          const parts = path.split("/").slice(2);
          if (parts[0] === "visibility" && opts.visibility) {
            return send(res, await handleVisibilityPage(opts.visibility, parts, origin));
          }
          if (opts.news) return send(res, await handlePublish(opts.news, parts, origin));
          return send(res, { status: 404, body: { ok: false, message: "Not found." } });
        }
        // Founder DM inbox: per-user threads + reply boxes (GET, Basic-auth).
        if (path === "/admin/dm" && opts.dm) {
          if (method !== "GET") {
            return send(res, { status: 405, body: { ok: false, message: "Use GET." } });
          }
          return send(res, await handleAdminDm(opts.dm, adminToken, req.headers.authorization ?? null));
        }
        // Founder reply to a user (form POST from the admin page, Basic-auth).
        if (path === "/admin/dm/reply" && opts.dm) {
          if (method !== "POST") {
            return send(res, { status: 405, body: { ok: false, message: "Use POST." } });
          }
          if (!sameOriginOk(req)) return send(res, BAD_ORIGIN);
          let form: URLSearchParams;
          try {
            form = await readForm(req);
          } catch {
            return send(res, { status: 400, body: { ok: false, message: "Bad request." } });
          }
          return send(
            res,
            await handleAdminDmReply(opts.dm, adminToken, req.headers.authorization ?? null, form),
          );
        }
        // Founder news publish (POST, same Basic-auth guard).
        if (path === "/admin/news" && opts.news) {
          if (method !== "POST") {
            return send(res, { status: 405, body: { ok: false, message: "Use POST." } });
          }
          if (!sameOriginOk(req)) return send(res, BAD_ORIGIN);
          let newsBody: unknown;
          try {
            newsBody = await readJson(req);
          } catch {
            return send(res, { status: 400, body: { ok: false, message: "Bad request." } });
          }
          return send(
            res,
            await handleAdminNews(opts.news, adminToken, req.headers.authorization ?? null, newsBody),
          );
        }
        // …and the authenticated send (POST, session bearer token).
        if (path === "/dm" && opts.dm) {
          if (method !== "POST") {
            return send(res, { status: 405, body: { ok: false, message: "Use POST." } });
          }
          let dmBody: unknown;
          try {
            dmBody = await readJson(req);
          } catch {
            return send(res, { status: 400, body: { ok: false, message: "Bad request." } });
          }
          return send(res, await handleDm(opts.dm, bearer(req), dmBody));
        }
        // The user's own conversation + unseen-reply count (GET, session).
        if (path === "/dm/thread" && opts.dm) {
          if (method !== "GET") {
            return send(res, { status: 405, body: { ok: false, message: "Use GET." } });
          }
          return send(res, await handleDmThread(opts.dm, bearer(req)));
        }
        // Publish an AI Visibility result → a public /u/visibility/:id link
        // (POST, session bearer — an outbound action needs an authenticated owner).
        if (path === "/publish/visibility" && opts.visibility) {
          if (method !== "POST") {
            return send(res, { status: 405, body: { ok: false, message: "Use POST." } });
          }
          let pubBody: unknown;
          try {
            pubBody = await readJson(req);
          } catch {
            return send(res, { status: 400, body: { ok: false, message: "Bad request." } });
          }
          return send(
            res,
            await handlePublishVisibility(
              { auth: opts.service, store: opts.visibility },
              bearer(req),
              pubBody,
              resolveOrigin(req, opts.publicOrigin),
            ),
          );
        }
        // Mark the user's founder replies as seen (POST, session).
        if (path === "/dm/read" && opts.dm) {
          if (method !== "POST") {
            return send(res, { status: 405, body: { ok: false, message: "Use POST." } });
          }
          return send(res, await handleDmRead(opts.dm, bearer(req)));
        }
        if (path !== "/auth/request" && path !== "/auth/verify") {
          return send(res, { status: 404, body: { ok: false, message: "Not found." } });
        }
        if (method !== "POST") {
          return send(res, { status: 405, body: { ok: false, message: "Use POST." } });
        }
        if (path === "/auth/request" && opts.limiter) {
          const key = `auth:${clientIp(req, opts.trustProxy ?? false)}`;
          if (!opts.limiter.take(key, LIMITS.authRequest)) {
            return send(res, {
              status: 429,
              body: { ok: false, message: "Lots of tries from here. Wait a few minutes and try again." },
              headers: { "retry-after": String(opts.limiter.retryAfter(key)) },
            });
          }
        }
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          return send(res, { status: 400, body: { ok: false, message: "Bad request." } });
        }
        const result =
          path === "/auth/request"
            ? await handleRequestLink(opts.service, body)
            : await handleVerify(opts.service, body);
        send(res, result);
      } catch {
        // never leak internals to the wire
        send(res, { status: 500, body: { ok: false, message: "Something went wrong." } });
      }
    })();
  });

  // Don't let a slow/half-open client tie up a socket forever (slowloris).
  server.requestTimeout = 10_000;

  return new Promise((resolve, reject) => {
    // A failure to bind (e.g. EADDRINUSE) must reject loudly, not hang.
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      // Once we're listening, a later socket error must not crash the process.
      server.on("error", (err) => console.error("[auth-server] socket error:", err.message));
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => void r());
            // Keep-alive sockets would hold close() open; in-flight requests still finish.
            server.closeIdleConnections();
          }),
      });
    });
  });
}
