import { describe, expect, it, vi } from "vitest";
import type { CapabilityRequest, PluginManifest } from "@skovern/plugin-sdk";
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
  const result = (input: GenerateInput): GenerateResult => ({
    text: reply,
    provider: "openrouter",
    model: "m",
    receipt: {
      ts: "x", provider: "openrouter", model: "m", task: input.task,
      bytesSent: 0, bytesReceived: 0, ok: true, phase: "done",
    },
  });
  return {
    generate: vi.fn(async (input: GenerateInput) => result(input)),
    generateStream: vi.fn(async (input: GenerateInput, onDelta: (d: string) => void) => {
      onDelta(reply);
      return result(input);
    }),
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

  it("allows loopback ONLY with the explicit dev/test flag, and refuses an invalid address", async () => {
    const fetchUrl = vi.fn(async () => "local page");
    const withFlag = createBroker({
      manifest: manifest(["fetch"]),
      brain: fakeRouter("x"),
      fetchUrl,
      fetchSink: fetchSink(),
      allowLoopback: true,
      now: FIXED,
    });

    // loopback (incl. IPv6 [::1]) is permitted when the flag is set
    expect((await withFlag.handle(req("fetch", "http://127.0.0.1:8080/x"))).ok).toBe(true);
    expect((await withFlag.handle(req("fetch", "http://[::1]:8080/x"))).ok).toBe(true);
    expect(fetchUrl).toHaveBeenCalledTimes(2);

    // a non-URL string is refused before any egress
    fetchUrl.mockClear();
    const bad = await withFlag.handle(req("fetch", "not a url"));
    expect(bad.ok).toBe(false);
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it("refuses plaintext loopback by DEFAULT (no flag) — no reaching local services", async () => {
    const sink = fetchSink();
    const fetchUrl = vi.fn();
    const broker = createBroker({
      manifest: manifest(["fetch"]),
      brain: fakeRouter("x"),
      fetchUrl,
      fetchSink: sink,
      now: FIXED,
    }); // allowLoopback omitted → production posture
    const res = await broker.handle(req("fetch", "http://127.0.0.1:8787/admin"));
    expect(res.ok).toBe(false);
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(sink.receipts).toHaveLength(0);
  });

  it("drops an unknown capability the manifest tries to smuggle in (no dispatch crash)", async () => {
    const broker = createBroker({
      // an untrusted manifest declaring a capability the runtime doesn't know
      manifest: manifest(["brain", "evil" as PluginManifest["capabilities"][number]]),
      brain: fakeRouter("hi"),
      fetchUrl: vi.fn(),
      fetchSink: fetchSink(),
      now: FIXED,
    });
    // the bogus cap was filtered out of `granted`, so requesting it is denied
    // (and never reaches the exhaustive switch → no assertNever throw)
    const res = await broker.handle(req("evil", "do harm"));
    expect(res.ok).toBe(false);
    // the real declared capability still works
    expect((await broker.handle(req("brain", "hi"))).ok).toBe(true);
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
    const boom = async (): Promise<never> => { throw new Error("sk-key-boom"); };
    const brain: Router = { generate: vi.fn(boom), generateStream: vi.fn(boom) };
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
