import { describe, expect, it } from "vitest";
import type { FetchSink } from "@skovern/core";
import { connectEngineOptions, hostIsOffBox, normalizeEndpoint } from "./connect-endpoint.js";

// Loop 044 — the connect-by-address trust boundary. `normalizeEndpoint` is the gate before any
// fetch; `hostIsOffBox` decides light-confirm (stays on your computer) vs egress-warning + receipts.

describe("connect-endpoint — normalizeEndpoint (the pre-fetch gate)", () => {
  it("U-norm-1: adds http:// when missing and returns the origin only (drops path/query/creds)", () => {
    expect(normalizeEndpoint("192.168.1.5:11434")).toBe("http://192.168.1.5:11434");
    expect(normalizeEndpoint("localhost:11434")).toBe("http://localhost:11434");
    expect(normalizeEndpoint("http://127.0.0.1:11434/api/tags?x=1")).toBe("http://127.0.0.1:11434"); // path+query dropped
    expect(normalizeEndpoint("  http://box.lan:1234  ")).toBe("http://box.lan:1234"); // trimmed
  });

  it("U-norm-2: refuses anything that isn't a valid http(s) host — before any fetch can happen", () => {
    expect(normalizeEndpoint("")).toBeNull();
    expect(normalizeEndpoint("   ")).toBeNull();
    expect(normalizeEndpoint("file:///etc/passwd")).toBeNull(); // non-http scheme (//)
    expect(normalizeEndpoint("file:/etc/passwd")).toBeNull(); // non-http scheme (single slash — no http://file mangling)
    expect(normalizeEndpoint("ws://10.0.0.5:11434")).toBeNull(); // websocket scheme
    expect(normalizeEndpoint("javascript:alert(1)")).toBeNull(); // never massaged into a host
    expect(normalizeEndpoint("http://")).toBeNull(); // no host
  });
});

describe("connect-endpoint — hostIsOffBox (ceremony gate)", () => {
  it("U-offbox: loopback stays on-box; every other host is off-box", () => {
    for (const on of ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"]) {
      expect(hostIsOffBox(on)).toBe(false);
    }
    for (const off of ["http://192.168.1.5:11434", "http://10.0.0.5:11434", "http://box.lan:1234", "http://example.com"]) {
      expect(hostIsOffBox(off)).toBe(true);
    }
    // An unparseable endpoint reads as on-box (it won't connect anyway) — never a false "leaves your computer".
    expect(hostIsOffBox("not a url")).toBe(false);
  });
});

describe("connect-endpoint — connectEngineOptions (fail-closed off-box receipting)", () => {
  // A recording sink: captures every receipt append, and can be made to FAIL to prove fail-closed.
  function recordingSink(fail = false): { sink: FetchSink; appends: { phase?: unknown; direction?: unknown; task?: unknown }[] } {
    const appends: { phase?: unknown; direction?: unknown; task?: unknown }[] = [];
    const sink: FetchSink = {
      append: async (r) => {
        appends.push(r as { phase?: unknown; direction?: unknown; task?: unknown });
        if (fail) throw new Error("sink down");
      },
    };
    return { sink, appends };
  }

  it("U1: OFF-BOX → allowOffBox AND a receipted fetch; a 'sent' receipt (direction:out) lands BEFORE the byte", async () => {
    const { sink, appends } = recordingSink();
    let fetched = false;
    const baseFetch = (async () => {
      // by the time the real fetch runs, the "sent" receipt must already be recorded (fail-closed).
      expect(appends.some((a) => a.phase === "sent")).toBe(true);
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const opts = connectEngineOptions("http://10.0.0.5:11434", true, sink);
    expect(opts.allowOffBox).toBe(true);
    expect(opts.fetchImpl).toBeDefined(); // off-box MUST get a wrapped fetch
    // Drive the wrapped fetch with our base fetch stubbed in (receiptedFetch calls global fetch —
    // so patch it for this call).
    const realFetch = globalThis.fetch;
    globalThis.fetch = baseFetch;
    try {
      await opts.fetchImpl!("http://10.0.0.5:11434/api/tags");
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toBe(true);
    const sent = appends.find((a) => a.phase === "sent");
    expect(sent?.direction).toBe("out"); // egress, tagged out
    expect(sent?.task).toBe("Skovern: your connected brain");
  });

  it("U1b: OFF-BOX is fail-closed — if the receipt sink throws, NO byte leaves", async () => {
    const { sink } = recordingSink(true); // sink fails on append
    let fetched = false;
    const baseFetch = (async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const opts = connectEngineOptions("http://10.0.0.5:11434", true, sink);
    const realFetch = globalThis.fetch;
    globalThis.fetch = baseFetch;
    try {
      await expect(opts.fetchImpl!("http://10.0.0.5:11434/api/tags")).rejects.toThrow(/sink down/);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toBe(false); // the receipt failed → the fetch never ran → nothing left the machine
  });

  it("U1c: ON-BOX (loopback) → NO wrapped fetch, so nothing is receipted (it never leaves)", () => {
    const { sink, appends } = recordingSink();
    const opts = connectEngineOptions("http://127.0.0.1:11434", false, sink);
    expect(opts.allowOffBox).toBe(false);
    expect(opts.fetchImpl).toBeUndefined(); // plain fetch — no egress receipt for a loopback brain
    expect(appends).toHaveLength(0);
  });
});
