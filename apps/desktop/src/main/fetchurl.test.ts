import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFetchUrl } from "./fetchurl.js";

// The SSRF guard is the whole point of letting a skill touch the network. Prove it
// rejects the ways a page-reader gets turned into a port-scanner / metadata thief,
// and still lets a normal request through.

let mock: Server;
let mockUrl: string;

beforeAll(async () => {
  mock = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello from the mock");
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  const { port } = mock.address() as AddressInfo;
  mockUrl = `http://127.0.0.1:${port}/`;
});

afterAll(() => {
  mock.close();
});

describe("fetchUrl SSRF guard (production: loopback off)", () => {
  const fetchUrl = createFetchUrl({ allowLoopback: false });

  it("rejects non-https", async () => {
    await expect(fetchUrl("http://example.com/")).rejects.toThrow("unsafe-scheme");
  });

  it.each([
    ["private 10.x", "https://10.0.0.1/"],
    ["private 172.16.x", "https://172.16.5.5/"],
    ["private 192.168.x", "https://192.168.1.1/"],
    ["link-local / metadata", "https://169.254.169.254/latest/meta-data/"],
    ["loopback 127.x", "https://127.0.0.1/"],
    ["unspecified 0.0.0.0", "https://0.0.0.0/"],
    ["IPv6 loopback", "https://[::1]/"],
    ["IPv4-mapped loopback (dotted)", "https://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped loopback (hex, URL-canonical)", "https://[::ffff:7f00:1]/"],
    ["IPv4-mapped metadata", "https://[::ffff:169.254.169.254]/"],
    ["IPv6 link-local", "https://[fe80::1]/"],
    ["IPv6 ULA", "https://[fc00::1]/"],
  ])("rejects %s (resolved private/loopback/link-local)", async (_name, url) => {
    // Assert the RANGE rejection specifically — a bare toThrow() would also pass on a
    // real connection error, which is exactly how the IPv4-mapped bypass (F1) hid.
    await expect(fetchUrl(url)).rejects.toThrow("blocked-ip");
  });

  it.each([
    ["decimal-encoded", "https://2130706433/"], // 127.0.0.1
    ["hex-encoded", "https://0x7f000001/"],
    ["octal-encoded", "https://0177.0.0.1/"],
    ["shorthand", "https://127.1/"],
  ])("rejects %s IP", async (_name, url) => {
    // These encoded spellings normalize (via WHATWG URL) to 127.0.0.1 → range-blocked.
    await expect(fetchUrl(url)).rejects.toThrow("blocked-ip");
  });

  it("blocks loopback even over https when loopback is off", async () => {
    const { port } = mock.address() as AddressInfo;
    await expect(fetchUrl(`https://127.0.0.1:${port}/`)).rejects.toThrow("blocked-ip");
  });
});

describe("fetchUrl dev/test seam (loopback on)", () => {
  it("allows a loopback http mock and returns its body", async () => {
    const fetchUrl = createFetchUrl({ allowLoopback: true });
    await expect(fetchUrl(mockUrl)).resolves.toContain("hello from the mock");
  });
});
