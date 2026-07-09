import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { handleRequestLink, handleVerify, type HttpResult } from "./handlers.js";
import type { AuthService } from "./service.js";

// Magic-link payloads are a few hundred bytes; cap hard so a flood can't buffer.
const MAX_BODY = 4096;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, result: HttpResult): void {
  res.writeHead(result.status, { "content-type": "application/json" });
  res.end(JSON.stringify(result.body));
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
export function startAuthServer(opts: { service: AuthService; port?: number }): Promise<RunningServer> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? "GET";
        const path = (req.url ?? "").split("?")[0] ?? "";
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

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise<void>((r) => server.close(() => void r())),
      });
    });
  });
}
