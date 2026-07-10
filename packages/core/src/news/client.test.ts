import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createNewsClient } from "./client.js";

let server: Server | undefined;

function fakeServer(reply: { status: number; body: unknown }) {
  return new Promise<string>((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
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

describe("news client", () => {
  it("returns well-formed posts", async () => {
    const post = { slug: "a", title: "A", body: "hi", publishedAt: "2026-07-10T00:00:00.000Z" };
    const base = await fakeServer({ status: 200, body: { ok: true, posts: [post] } });
    expect(await createNewsClient(base).list()).toEqual([post]);
  });

  it("drops malformed posts and tolerates a missing array", async () => {
    const good = { slug: "a", title: "A", body: "hi", publishedAt: "2026-07-10T00:00:00.000Z" };
    const base = await fakeServer({ status: 200, body: { posts: [good, { slug: 1 }, null] } });
    expect(await createNewsClient(base).list()).toEqual([good]);
  });

  it("returns [] on a server error", async () => {
    const base = await fakeServer({ status: 500, body: {} });
    expect(await createNewsClient(base).list()).toEqual([]);
  });
});
