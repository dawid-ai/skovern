import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
import { handlePublish } from "../publish/handlers.js";

// Magic-link payloads are a few hundred bytes; cap hard so a flood can't buffer.
const MAX_BODY = 4096;

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(buf);
  }
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  return raw ? JSON.parse(raw) : {};
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readRawBody(req));
}

function send(res: ServerResponse, result: HttpResult): void {
  const contentType = result.contentType ?? "application/json";
  res.writeHead(result.status, { "content-type": contentType, ...result.headers });
  const payload =
    contentType === "application/json" ? JSON.stringify(result.body) : String(result.body);
  res.end(payload);
}

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

/**
 * The tiny cloud API over Node's stdlib http — no framework. Exposes the
 * loop-002 handlers at POST /auth/request and /auth/verify. Returned as a
 * factory so tests (and a future dev runner) can start it in-process.
 */
function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

export function startAuthServer(opts: {
  service: AuthService;
  news?: NewsStore;
  dm?: DmDeps;
  /** Guards the founder admin surface (DM thread, news publish). Null = off. */
  adminToken?: string | null;
  /** Absolute public base (e.g. https://deskhand.app) for og:image URLs. When
   *  set it wins over the request Host header, so a spoofed Host/proto can't be
   *  reflected into published pages. */
  publicOrigin?: string;
  port?: number;
}): Promise<RunningServer> {
  const adminToken = opts.adminToken ?? null;
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? "GET";
        const path = (req.url ?? "").split("?")[0] ?? "";
        // Public news feed — GET only, no auth (readable without account).
        if (path === "/news" && opts.news) {
          if (method !== "GET") {
            return send(res, { status: 405, body: { ok: false, message: "Use GET." } });
          }
          return send(res, await handleNews(opts.news));
        }
        // Public published pages + OG cards, e.g. /u/news/<slug>[/og.svg].
        if (path.startsWith("/u/") && opts.news) {
          if (method !== "GET") {
            return send(res, { status: 405, body: { ok: false, message: "Use GET." } });
          }
          // Prefer the configured public origin; only fall back to the (spoofable)
          // Host header for local dev, honoring a TLS proxy's forwarded scheme.
          let origin = opts.publicOrigin;
          if (!origin) {
            const fwd = req.headers["x-forwarded-proto"];
            const proto = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0] ?? "http";
            origin = `${proto}://${req.headers.host ?? "127.0.0.1"}`;
          }
          return send(res, await handlePublish(opts.news, path.split("/").slice(2), origin));
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
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      // Once we're listening, a later socket error must not crash the process.
      server.on("error", (err) => console.error("[auth-server] socket error:", err.message));
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise<void>((r) => server.close(() => void r())),
      });
    });
  });
}
