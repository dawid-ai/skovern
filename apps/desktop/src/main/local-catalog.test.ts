import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchReceipt, FetchSink } from "@deskhand/core";

// receipts.ts imports electron for app.getPath — stub it so the import resolves.
vi.mock("electron", () => ({ app: { getPath: () => "." } }));

import { createCachedCatalogLoader, loadCatalog, snapshotCatalog, validateCatalog } from "./catalog.js";

// C1 — the catalog: a valid live fetch parses; a failed/malformed fetch falls back
// to the bundled snapshot AND yields a descriptive notice; the fetch goes through
// the 015 receiptedFetch so a fetch receipt (github egress) is written; catalog
// strings are validated as untrusted input (bad entries dropped, non-http links refused).

let server: Server | null = null;

function startFixture(status: number, body: string): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}/catalog/models.json`);
    });
  });
}

function collectingSink(): { sink: FetchSink; receipts: FetchReceipt[] } {
  const receipts: FetchReceipt[] = [];
  return { sink: { append: (r) => void receipts.push(r) }, receipts };
}

const GOOD_DOC = JSON.stringify({
  models: [
    {
      id: "qwen2.5:3b",
      label: "Qwen 3B",
      params: 3,
      sizeBytes: 2_000_000_000,
      quant: "Q4_K_M",
      creator: "Alibaba",
      homepage: "https://huggingface.co/Qwen",
      license: "Apache 2.0",
      licenseUrl: "https://apache.org/licenses/LICENSE-2.0",
      tradeoff: "A solid everyday pick.",
    },
  ],
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe("loadCatalog (C1)", () => {
  it("parses a valid live catalog and writes a receipted fetch (github egress)", async () => {
    const url = await startFixture(200, GOOD_DOC);
    const { sink, receipts } = collectingSink();
    const result = await loadCatalog(sink, url);

    expect(result.source).toBe("live");
    expect(result.models.map((m) => m.id)).toEqual(["qwen2.5:3b"]);
    expect(result.notice).toBeUndefined();

    // the fetch was receipted with the model-list label (a fetch/egress receipt)
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    expect(receipts.every((r) => r.kind === "fetch")).toBe(true);
    expect(receipts.every((r) => r.task === "Deskhand: model list")).toBe(true);
    expect(receipts.some((r) => r.phase === "sent")).toBe(true);
    // classified routine at the SOURCE (housekeeping poll) → the panel groups it.
    expect(receipts.every((r) => r.routine === true)).toBe(true);
  });

  it("falls back to the bundled snapshot with a descriptive notice on a non-200", async () => {
    const url = await startFixture(500, "server error");
    const { sink } = collectingSink();
    const result = await loadCatalog(sink, url);

    expect(result.source).toBe("snapshot");
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models).toEqual(snapshotCatalog());
    expect(result.notice).toMatch(/built-in list|couldn't/i);
  });

  it("falls back to the snapshot with a notice on a malformed body", async () => {
    const url = await startFixture(200, "this is not json");
    const { sink } = collectingSink();
    const result = await loadCatalog(sink, url);

    expect(result.source).toBe("snapshot");
    expect(result.notice).toMatch(/looked wrong|built-in/i);
  });

  it("falls back to the snapshot (with a notice) when the server is unreachable", async () => {
    const { sink, receipts } = collectingSink();
    // Nothing listening on this loopback port → connection refused.
    const result = await loadCatalog(sink, "http://127.0.0.1:1/catalog/models.json");

    expect(result.source).toBe("snapshot");
    expect(result.notice).toMatch(/offline|couldn't reach/i);
    // still receipted the attempt (fail-closed "sent" line)
    expect(receipts.some((r) => r.phase === "sent")).toBe(true);
  });
});

describe("createCachedCatalogLoader — collapses the local view's double fetch", () => {
  // A fixture that counts how many times it's actually hit over the wire.
  function startCounting(good: string): Promise<{ url: string; hits: () => number }> {
    let count = 0;
    return new Promise((resolve) => {
      server = createServer((_req, res) => {
        count += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(good);
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server!.address() as AddressInfo;
        resolve({ url: `http://127.0.0.1:${port}/catalog/models.json`, hits: () => count });
      });
    });
  }

  it("shares ONE fetch for two loads within the TTL (status+models), refetches past it", async () => {
    const { url, hits } = await startCounting(GOOD_DOC);
    const { sink, receipts } = collectingSink();
    let clock = 1000;
    const load = createCachedCatalogLoader(() => clock);

    // the near-simultaneous status+models pair → ONE fetch, ONE "sent" receipt
    const [a, b] = await Promise.all([load(sink, url), load(sink, url)]);
    expect(a.source).toBe("live");
    expect(b.source).toBe("live");
    expect(hits()).toBe(1);
    expect(receipts.filter((r) => r.phase === "sent").length).toBe(1);

    // still inside the TTL window → cached, no new fetch
    clock += 2000; // 2s later
    await load(sink, url);
    expect(hits()).toBe(1);

    // past the TTL → an intentional rescan gets a fresh list (never permanently stale)
    clock += 2000; // now 4s since the first load → > 3s TTL
    await load(sink, url);
    expect(hits()).toBe(2);
  });
});

describe("validateCatalog — untrusted input", () => {
  it("drops entries with a non-http(s) link (javascript:, data:, file:)", () => {
    const models = validateCatalog({
      models: [
        // malicious homepage — must be dropped
        { id: "bad", label: "Bad", params: 3, sizeBytes: 1, quant: "Q4", creator: "x", homepage: "javascript:alert(1)", license: "l", licenseUrl: "https://ok.test" },
        // good
        JSON.parse(GOOD_DOC).models[0],
      ],
    });
    expect(models).not.toBeNull();
    expect(models!.map((m) => m.id)).toEqual(["qwen2.5:3b"]);
  });

  it("returns null for a doc with no valid models (so the caller falls back)", () => {
    expect(validateCatalog({ models: [{ id: 123 }] })).toBeNull();
    expect(validateCatalog({ nope: true })).toBeNull();
    expect(validateCatalog("not an object")).toBeNull();
  });

  it("rejects negative/absent numeric fields", () => {
    const models = validateCatalog({
      models: [{ id: "x", label: "X", params: -1, sizeBytes: 10, quant: "Q4", creator: "c", homepage: "https://a.test", license: "l", licenseUrl: "https://b.test", tradeoff: "t" }],
    });
    expect(models).toBeNull();
  });
});

describe("validateCatalog — gguf block (embedded runtime, untrusted input)", () => {
  const goodGguf = {
    url: "https://huggingface.co/x/m.gguf",
    sha256: "a".repeat(64),
    sizeBytes: 2_000_000_000,
    filename: "m-q4.gguf",
    contextSize: 4096,
  };
  function modelWith(gguf: unknown): unknown {
    return { ...JSON.parse(GOOD_DOC).models[0], gguf };
  }

  it("keeps a model with a well-formed gguf block (populated)", () => {
    const models = validateCatalog({ models: [modelWith(goodGguf)] });
    expect(models).not.toBeNull();
    expect(models![0]!.gguf).toEqual(goodGguf);
  });

  it("keeps a model with NO gguf block (Ollama-only) — gguf undefined", () => {
    const models = validateCatalog(JSON.parse(GOOD_DOC)); // GOOD_DOC has no gguf
    expect(models).not.toBeNull();
    expect(models![0]!.gguf).toBeUndefined();
  });

  // A present-but-malformed gguf DROPS the whole model, so a bad url/sha256/filename can
  // never reach the downloader (a path/network sink). Each bad field → entry gone.
  it("drops the model when gguf.url is not https", () => {
    expect(validateCatalog({ models: [modelWith({ ...goodGguf, url: "http://x/m.gguf" })] })).toBeNull();
    expect(validateCatalog({ models: [modelWith({ ...goodGguf, url: "file:///etc/passwd" })] })).toBeNull();
  });

  it("drops the model when gguf.sha256 isn't 64 lowercase hex", () => {
    expect(validateCatalog({ models: [modelWith({ ...goodGguf, sha256: "not-hex" })] })).toBeNull();
    expect(validateCatalog({ models: [modelWith({ ...goodGguf, sha256: "A".repeat(64) })] })).toBeNull(); // uppercase
    expect(validateCatalog({ models: [modelWith({ ...goodGguf, sha256: "a".repeat(63) })] })).toBeNull(); // too short
  });

  it("drops the model when gguf.filename could traverse or isn't a .gguf", () => {
    expect(validateCatalog({ models: [modelWith({ ...goodGguf, filename: "../evil.gguf" })] })).toBeNull();
    expect(validateCatalog({ models: [modelWith({ ...goodGguf, filename: "sub/dir.gguf" })] })).toBeNull();
    expect(validateCatalog({ models: [modelWith({ ...goodGguf, filename: "model.bin" })] })).toBeNull();
  });

  it("drops the model when gguf sizes aren't positive finite numbers", () => {
    expect(validateCatalog({ models: [modelWith({ ...goodGguf, sizeBytes: 0 })] })).toBeNull();
    expect(validateCatalog({ models: [modelWith({ ...goodGguf, contextSize: -1 })] })).toBeNull();
  });
});
