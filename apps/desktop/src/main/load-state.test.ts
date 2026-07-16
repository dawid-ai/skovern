import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ollamaResidentModels } from "@deskhand/core";

// receipts.ts (transitive via local.ts) imports electron for app.getPath — stub it, dev seams on.
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => "." } }));

import { modelLoaded } from "./local.js";

// Loop 034 — the load-state probe behind the green/gray brain chip. The Ollama half reads
// `/api/ps` (resident models); the embedded half reads the warm child. It's a bare on-machine
// status ping — NEVER receipted (U6): receipting a 5s poll would spam the flagship privacy
// panel, so the probe issues one plain GET and touches no receipt sink.

function psServer(status: number, body: string): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      hits.push(req.url ?? "");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, hits });
    });
  });
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  delete process.env["DESKHAND_OLLAMA_URL"];
  delete process.env["DESKHAND_BRAIN_LOADED"];
});

describe("ollamaResidentModels (the probe)", () => {
  it("U5: returns the resident model names from /api/ps", async () => {
    const { url } = await psServer(200, JSON.stringify({ models: [{ name: "qwen2.5:3b" }, { model: "llama3.2:1b" }] }));
    expect(await ollamaResidentModels(url)).toEqual(["qwen2.5:3b", "llama3.2:1b"]);
  });

  it("is fail-soft — [] on an error status, bad shape, or a refused connection (never throws)", async () => {
    const err = await psServer(500, "nope");
    expect(await ollamaResidentModels(err.url)).toEqual([]);
    const weird = await psServer(200, JSON.stringify({ models: "not-an-array" }));
    expect(await ollamaResidentModels(weird.url)).toEqual([]);
    // Nothing listening on this port → connection refused → [].
    expect(await ollamaResidentModels("http://127.0.0.1:9")).toEqual([]);
  });

  it("refuses a non-loopback address (privacy) → []", async () => {
    expect(await ollamaResidentModels("http://evil.example.com:11434")).toEqual([]);
  });

  it("U6: issues exactly ONE bare GET /api/ps via the injected fetch — no receipt wrapper", async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "qwen2.5:3b" }] }), { status: 200 }));
    const ids = await ollamaResidentModels("http://127.0.0.1:11434", spy as unknown as typeof fetch);
    expect(ids).toEqual(["qwen2.5:3b"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String((spy.mock.calls[0] as unknown[])[0])).toContain("/api/ps");
  });
});

describe("modelLoaded (chip source of truth)", () => {
  it("U5: an Ollama model is loaded iff /api/ps lists it", async () => {
    const { url } = await psServer(200, JSON.stringify({ models: [{ name: "qwen2.5:coder" }] }));
    process.env["DESKHAND_OLLAMA_URL"] = url;
    expect(await modelLoaded("qwen2.5:coder")).toBe(true);
    expect(await modelLoaded("some-other:model")).toBe(false);
  });

  it("false for a null/absent model, and for an embedded model with no warm child", async () => {
    expect(await modelLoaded(null)).toBe(false);
    // qwen2.5:3b is an embedded (gguf) model → reads the warm child, which is cold in a fresh test.
    expect(await modelLoaded("qwen2.5:3b")).toBe(false);
  });
});
