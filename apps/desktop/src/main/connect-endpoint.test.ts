import { describe, expect, it } from "vitest";
import { hostIsOffBox, normalizeEndpoint } from "./connect-endpoint.js";

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
    expect(normalizeEndpoint("file:///etc/passwd")).toBeNull(); // non-http scheme
    expect(normalizeEndpoint("ws://10.0.0.5:11434")).toBeNull(); // websocket scheme
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
