import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAccountClient } from "./client.js";

// A stand-in for the real auth server: records requests and replies with
// whatever the test sets. No Postgres, no site package — just the HTTP contract.
let server: Server | undefined;

function fakeServer(handler: (path: string, body: unknown) => { status: number; body: unknown }) {
  return new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const out = handler(req.url ?? "", parsed);
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

describe("account client", () => {
  it("sends the email on requestMagicLink", async () => {
    let seen: unknown = null;
    const base = await fakeServer((path, body) => {
      seen = { path, body };
      return { status: 200, body: { ok: true } };
    });
    await createAccountClient(base).requestMagicLink("a@shop.test");
    expect(seen).toEqual({ path: "/auth/request", body: { email: "a@shop.test" } });
  });

  it("returns the session on a good verify", async () => {
    const base = await fakeServer(() => ({
      status: 200,
      body: { ok: true, session: "id.secret", ogNumber: 7 },
    }));
    const session = await createAccountClient(base).verifyMagicLink("id.secret");
    expect(session).toEqual({ token: "id.secret", ogNumber: 7 });
  });

  it("returns null on a rejected verify", async () => {
    const base = await fakeServer(() => ({ status: 401, body: { ok: false } }));
    expect(await createAccountClient(base).verifyMagicLink("bad")).toBeNull();
  });

  it("returns null when the server answers ok but with a malformed body", async () => {
    const base = await fakeServer(() => ({ status: 200, body: { ok: true } }));
    expect(await createAccountClient(base).verifyMagicLink("x")).toBeNull();
  });
});
