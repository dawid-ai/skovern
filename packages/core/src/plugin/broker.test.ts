import { describe, expect, it, vi } from "vitest";
import type { CapabilityRequest, PluginManifest } from "@deskhand/plugin-sdk";
import { createBroker } from "./broker.js";
import type { FetchReceipt, FetchSink } from "./receipt.js";
import type { GenerateInput, GenerateResult, Router } from "../router/types.js";

const FIXED = () => new Date("2026-07-10T19:00:00.000Z");

function manifest(caps: PluginManifest["capabilities"]): PluginManifest {
  return { id: "hello", name: "Hello skill", description: "says hi", capabilities: caps };
}

// A router stub — the real one (loop 011) already receipts model egress, so the
// broker just forwards to it.
function fakeRouter(reply: string): Router {
  return {
    generate: vi.fn(async (input: GenerateInput): Promise<GenerateResult> => ({
      text: reply,
      provider: "openrouter",
      model: "m",
      receipt: {
        ts: "x", provider: "openrouter", model: "m", task: input.task,
        bytesSent: 0, bytesReceived: 0, ok: true, phase: "done",
      },
    })),
  };
}

function fetchSink(): FetchSink & { receipts: FetchReceipt[] } {
  const receipts: FetchReceipt[] = [];
  return { receipts, append: (r) => void receipts.push(r) };
}

function req(capability: string, arg: string): CapabilityRequest {
  return { id: 1, capability: capability as CapabilityRequest["capability"], arg };
}

describe("permission broker", () => {
  it("grants a declared capability and denies an undeclared one", async () => {
    const sink = fetchSink();
    const fetchUrl = vi.fn(async () => "page body");
    const broker = createBroker({
      manifest: manifest(["brain"]),
      brain: fakeRouter("brain says hi"),
      fetchUrl,
      fetchSink: sink,
      now: FIXED,
    });

    const good = await broker.handle(req("brain", "think about hats"));
    expect(good).toMatchObject({ ok: true, result: "brain says hi" });

    // fetch was NOT declared → denied, and the network is never touched
    const bad = await broker.handle(req("fetch", "https://example.com"));
    expect(bad.ok).toBe(false);
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(sink.receipts).toHaveLength(0);
  });

  it("denies a forged/unknown capability the manifest never listed", async () => {
    const broker = createBroker({
      manifest: manifest(["brain"]),
      brain: fakeRouter("hi"),
      fetchUrl: vi.fn(),
      fetchSink: fetchSink(),
      now: FIXED,
    });
    const res = await broker.handle(req("filesystem", "/etc/passwd"));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/permission/i);
  });

  it("gates fetch, receipts it fail-closed (sent before done), and returns the page", async () => {
    const sink = fetchSink();
    const fetchUrl = vi.fn(async () => "the page text");
    const broker = createBroker({
      manifest: manifest(["fetch"]),
      brain: fakeRouter("unused"),
      fetchUrl,
      fetchSink: sink,
      now: FIXED,
    });

    const res = await broker.handle(req("fetch", "https://shop.example/about?secret=xyz"));
    expect(res).toMatchObject({ ok: true, result: "the page text" });
    // two receipts: "sent" before the fetch, "done" after
    expect(sink.receipts.map((r) => r.phase)).toEqual(["sent", "done"]);
    const [sent, done] = sink.receipts;
    expect(sent).toMatchObject({ kind: "fetch", host: "shop.example", task: "skill:hello fetch", phase: "sent", ok: false });
    expect(done).toMatchObject({ host: "shop.example", ok: true, phase: "done" });
    // metadata only: no full URL / query-string secret, no body in the log
    const dump = JSON.stringify(sink.receipts);
    expect(dump).not.toContain("secret=xyz");
    expect(dump).not.toContain("the page text");
  });

  it("is fail-closed on fetch: a throwing sink stops the egress before it happens", async () => {
    const fetchUrl = vi.fn(async () => "leaked");
    const broker = createBroker({
      manifest: manifest(["fetch"]),
      brain: fakeRouter("x"),
      fetchUrl,
      fetchSink: { append: () => { throw new Error("disk full"); } },
      now: FIXED,
    });
    await expect(broker.handle(req("fetch", "https://example.com"))).rejects.toThrow(/disk full/);
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it("refuses an unsafe (non-https, non-loopback) web address without egress", async () => {
    const sink = fetchSink();
    const fetchUrl = vi.fn();
    const broker = createBroker({
      manifest: manifest(["fetch"]),
      brain: fakeRouter("x"),
      fetchUrl,
      fetchSink: sink,
      now: FIXED,
    });
    const res = await broker.handle(req("fetch", "http://evil.example/steal"));
    expect(res.ok).toBe(false);
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(sink.receipts).toHaveLength(0);
  });

  it("allows a loopback fetch (dev/test seam), and refuses an invalid address without egress", async () => {
    const sink = fetchSink();
    const fetchUrl = vi.fn(async () => "local page");
    const broker = createBroker({
      manifest: manifest(["fetch"]),
      brain: fakeRouter("x"),
      fetchUrl,
      fetchSink: sink,
      now: FIXED,
    });

    // loopback (incl. IPv6 [::1]) is permitted
    expect((await broker.handle(req("fetch", "http://127.0.0.1:8080/x"))).ok).toBe(true);
    expect((await broker.handle(req("fetch", "http://[::1]:8080/x"))).ok).toBe(true);
    expect(fetchUrl).toHaveBeenCalledTimes(2);

    // a non-URL string is refused before any egress
    fetchUrl.mockClear();
    const bad = await broker.handle(req("fetch", "not a url"));
    expect(bad.ok).toBe(false);
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it("still returns the page if only the finalize (done) receipt write fails", async () => {
    let n = 0;
    const fetchUrl = vi.fn(async () => "page body");
    const broker = createBroker({
      manifest: manifest(["fetch"]),
      brain: fakeRouter("x"),
      fetchUrl,
      // throw on the 2nd append (the "done" finalize) — egress is already
      // receipted by the "sent" line, so the user must still get their answer
      fetchSink: { append: () => { if (++n === 2) throw new Error("late write"); } },
      now: FIXED,
    });
    const res = await broker.handle(req("fetch", "https://example.com"));
    expect(res).toMatchObject({ ok: true, result: "page body" });
  });

  it("surfaces a generic error when the brain fails (no provider detail leaks)", async () => {
    const brain: Router = { generate: vi.fn(async () => { throw new Error("sk-key-boom"); }) };
    const broker = createBroker({
      manifest: manifest(["brain"]),
      brain,
      fetchUrl: vi.fn(),
      fetchSink: fetchSink(),
      now: FIXED,
    });
    const res = await broker.handle(req("brain", "hi"));
    expect(res.ok).toBe(false);
    expect(JSON.stringify(res)).not.toContain("sk-key-boom");
  });
});
