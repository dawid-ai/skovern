import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDmClient } from "./client.js";

let server: Server | undefined;

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

function fakeServer(handler: (seen: Seen) => { status: number; body: unknown }) {
  return new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const out = handler({
          method: req.method ?? "GET",
          url: req.url ?? "",
          auth: req.headers.authorization,
          body: parsed,
        });
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
    let seen: Seen | null = null;
    const base = await fakeServer((s) => {
      seen = s;
      return { status: 200, body: { ok: true, message: "Got it — Dawid will see this. Thanks!" } };
    });
    const res = await createDmClient(base).send("id.secret", "hello");
    expect(seen).toMatchObject({ method: "POST", url: "/dm", auth: "Bearer id.secret", body: { message: "hello" } });
    expect(res).toEqual({ ok: true, message: "Got it — Dawid will see this. Thanks!" });
  });

  it("returns ok:false with a fallback message on rejection", async () => {
    const base = await fakeServer(() => ({ status: 401, body: {} }));
    const res = await createDmClient(base).send("bad", "hi");
    expect(res.ok).toBe(false);
    expect(res.message.length).toBeGreaterThan(0);
  });

  it("fetches the thread with a bearer token and keeps only well-formed turns", async () => {
    let seen: Seen | null = null;
    const good = { sender: "founder", body: "hey", createdAt: "2026-07-10T00:00:00.000Z" };
    const base = await fakeServer((s) => {
      seen = s;
      return { status: 200, body: { ok: true, messages: [good, { sender: "alien" }, null], unread: 2 } };
    });
    const thread = await createDmClient(base).thread("id.secret");
    expect(seen).toMatchObject({ method: "GET", url: "/dm/thread", auth: "Bearer id.secret" });
    expect(thread).toEqual({ messages: [good], unread: 2 });
  });

  it("returns an empty thread on a server error", async () => {
    const base = await fakeServer(() => ({ status: 500, body: {} }));
    expect(await createDmClient(base).thread("x")).toEqual({ messages: [], unread: 0 });
  });

  it("marks read with a POST and bearer token", async () => {
    let seen: Seen | null = null;
    const base = await fakeServer((s) => {
      seen = s;
      return { status: 200, body: { ok: true } };
    });
    await createDmClient(base).markRead("id.secret");
    expect(seen).toMatchObject({ method: "POST", url: "/dm/read", auth: "Bearer id.secret" });
  });
});
