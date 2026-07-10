import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDmClient } from "./client.js";

let server: Server | undefined;

function fakeServer(handler: (auth: string | undefined, body: unknown) => { status: number; body: unknown }) {
  return new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const out = handler(req.headers.authorization, parsed);
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe("dm client", () => {
  it("sends the message with a bearer token and returns the server message", async () => {
    let seen: { auth: string | undefined; body: unknown } | null = null;
    const base = await fakeServer((auth, body) => {
      seen = { auth, body };
      return { status: 200, body: { ok: true, message: "Got it — Dawid will see this. Thanks!" } };
    });
    const res = await createDmClient(base).send("id.secret", "hello");
    expect(seen).toEqual({ auth: "Bearer id.secret", body: { message: "hello" } });
    expect(res).toEqual({ ok: true, message: "Got it — Dawid will see this. Thanks!" });
  });

  it("returns ok:false with a fallback message on rejection", async () => {
    const base = await fakeServer(() => ({ status: 401, body: {} }));
    const res = await createDmClient(base).send("bad", "hi");
    expect(res.ok).toBe(false);
    expect(res.message.length).toBeGreaterThan(0);
  });
});
