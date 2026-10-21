import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchReceipt } from "@skovern/core";
import { fakeOllamaZip, makeZip } from "../../e2e/zip-fixture.js";

const state = { dir: "", packaged: false };
vi.mock("electron", () => ({
  app: {
    getPath: () => state.dir,
    get isPackaged() {
      return state.packaged;
    },
  },
}));

import { installManagedOllama, managedOllamaBin, managedOllamaRoot, ollamaDist } from "./ollama-dist.js";
import { checkZipEntries, unsafeEntryReason } from "./zip-entries.js";

const EXE = process.platform === "win32" ? "ollama.exe" : "ollama";

function serveBytes(bytes: Buffer): typeof fetch {
  return (async () => new Response(new Uint8Array(bytes), { status: 200 })) as unknown as typeof fetch;
}
function useZip(bytes: Buffer): void {
  process.env["SKOVERN_OLLAMA_DIST_URL"] = "http://127.0.0.1:1/unused"; // bytes come from the injected fetch
  process.env["SKOVERN_OLLAMA_DIST_SHA256"] = createHash("sha256").update(bytes).digest("hex");
  process.env["SKOVERN_OLLAMA_DIST_SIZE"] = String(bytes.length);
}
function sink(): { receipts: FetchReceipt[]; append: (r: FetchReceipt) => void } {
  const receipts: FetchReceipt[] = [];
  return { receipts, append: (r) => void receipts.push(r) };
}
// Every file anywhere under the temp userData, relative — to prove nothing landed outside.
function allFiles(dir: string, rel = ""): string[] {
  return readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? allFiles(dir, path.join(rel, d.name)) : [path.join(rel, d.name)],
  );
}

beforeEach(() => {
  state.dir = mkdtempSync(path.join(tmpdir(), "skovern-ollama-dist-"));
  state.packaged = false;
});
afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true });
  delete process.env["SKOVERN_OLLAMA_DIST_URL"];
  delete process.env["SKOVERN_OLLAMA_DIST_SHA256"];
  delete process.env["SKOVERN_OLLAMA_DIST_SIZE"];
});

describe("M8: unsafe zip entry names are refused with a reason", () => {
  it.each([
    ["../evil.exe", /climbs out/],
    ["lib/../../evil.dll", /climbs out/],
    ["lib\\..\\..\\evil.dll", /climbs out/],
    ["/etc/passwd", /absolute path/],
    ["\\Windows\\evil.dll", /absolute path/],
    ["C:/Windows/evil.dll", /drive letter/],
    ["c:evil.dll", /drive letter/],
    ["", /empty/],
    ["ok\0.exe", /null byte/],
    ["lib/x.dll:stream", /hidden file stream/],
    ["lib/evil.", /Windows would change/],
    ["lib/evil ", /Windows would change/],
    ["NUL", /device name/],
    ["lib/con.txt", /device name/],
    ["lib/COM1", /device name/],
  ])("%j → refused", (name, reason) => {
    expect(unsafeEntryReason(name)).toMatch(reason);
  });

  const file = (name: string) => ({ name, unixType: name.endsWith("/") ? 0o040000 : 0o100000 });
  it("ordinary names pass, including dots that aren't '..' and names like 'console'", () => {
    expect(checkZipEntries(["ollama.exe", "lib/", "lib/ollama/ggml.dll", "lib/ollama/..hidden", "a.b/c", "console.dll"].map(file))).toBeNull();
    expect(checkZipEntries([{ name: "plain.txt", unixType: 0 }])).toBeNull(); // no unix bits (a Windows-made zip)
  });

  it("a link or special file is refused by type, whatever its name", () => {
    expect(checkZipEntries([file("ollama.exe"), { name: "lib/x", unixType: 0o120000 }])).toMatch(/link or special file/);
    expect(checkZipEntries([{ name: "lib/fifo", unixType: 0o010000 }])).toMatch(/link or special file/);
  });
});

describe("the pin", () => {
  it("M10: a packaged app ignores the test seam and only ever reads the in-code pin", () => {
    useZip(fakeOllamaZip());
    state.packaged = true;
    const d = ollamaDist();
    if (process.platform === "win32" && process.arch === "x64") {
      expect(d?.sha256).toBe("e359637575302f288d76c0007c408a4be9c7376d59c4f28684d63b232a44b427");
      expect(d?.url).toBe("https://github.com/ollama/ollama/releases/download/v0.40.6/ollama-windows-amd64.zip");
    } else {
      expect(d).toBeNull(); // no pin for this platform yet (049)
    }
  });

  it("the test seam keeps an https github url, so the https-only rule and the receipt host are real", () => {
    useZip(fakeOllamaZip());
    expect(ollamaDist()!.url).toMatch(/^https:\/\/github\.com\//);
  });
});

describe("installManagedOllama", () => {
  it("downloads with a receipt, unpacks into userData/ollama/<version>/, removes the zip", { timeout: 30_000 }, async () => {
    const zip = fakeOllamaZip();
    useZip(zip);
    const s = sink();
    const bin = await installManagedOllama(s, undefined, serveBytes(zip));
    expect(bin).toBe(path.join(managedOllamaRoot(), "0.0.0-test", EXE));
    expect(managedOllamaBin()).toBe(bin);
    expect(s.receipts.map((r) => [r.phase, r.host, r.ok])).toEqual([
      ["sent", "github.com", false],
      ["done", "github.com", true],
    ]);
    expect(readdirSync(managedOllamaRoot()).sort()).toEqual(["0.0.0-test"]); // no zip, no .partial
  });

  it("M4(a): a sha256 mismatch → plain message, nothing unpacked, nothing left behind", async () => {
    const zip = fakeOllamaZip();
    useZip(zip);
    process.env["SKOVERN_OLLAMA_DIST_SHA256"] = "0".repeat(64);
    await expect(installManagedOllama(sink(), undefined, serveBytes(zip))).rejects.toThrow(
      "The helper download didn't match its safety check and was removed. Try again.",
    );
    expect(managedOllamaBin()).toBeNull();
    expect(existsSync(managedOllamaRoot()) ? readdirSync(managedOllamaRoot()) : []).toEqual([]);
  });

  it("M8: a zip with a climbing entry is refused BEFORE unpacking — nothing lands outside", async () => {
    const zip = makeZip([{ name: EXE, data: "x" }, { name: "../../escaped.txt", data: "pwned" }]);
    useZip(zip);
    await expect(installManagedOllama(sink(), undefined, serveBytes(zip))).rejects.toThrow(/climbs out of its folder/);
    expect(managedOllamaBin()).toBeNull();
    expect(allFiles(state.dir).filter((f) => f.includes("escaped"))).toEqual([]);
    expect(readdirSync(managedOllamaRoot())).toEqual([]); // .partial and zip both removed
  });

  // Checker B1: a link followed by a file UNDER it would write through the link. The zip's own
  // file list is read first, so the system unzip never runs and nothing lands anywhere.
  it.each([
    ["an absolute target", () => path.join(state.dir, "outside")],
    ["a climbing target", () => "../../.."],
  ])("M8: a link + a file under it (%s) is refused before unpacking — nothing written outside", async (_label, target) => {
    const zip = makeZip([
      { name: EXE, data: "x" },
      { name: "lnk", data: target(), symlink: true },
      { name: "lnk/startup.bat", data: "pwned" },
    ]);
    useZip(zip);
    await expect(installManagedOllama(sink(), undefined, serveBytes(zip))).rejects.toThrow(/a link or special file \(lnk\)/);
    expect(managedOllamaBin()).toBeNull();
    expect(allFiles(state.dir).filter((f) => f.endsWith("startup.bat"))).toEqual([]);
    expect(readdirSync(managedOllamaRoot())).toEqual([]); // the unzip never ran: no .partial
  });

  it("M8: a local header that names a different file than the list is refused", async () => {
    const zip = makeZip([{ name: EXE, data: "x" }, { name: "lib/ok.dll", localName: "../../evil.dll", data: "pwned" }]);
    useZip(zip);
    await expect(installManagedOllama(sink(), undefined, serveBytes(zip))).rejects.toThrow(/two names disagree/);
    expect(allFiles(state.dir).filter((f) => f.includes("evil"))).toEqual([]);
  });

  it("N7: after an app update moves the pin, the helper set up before keeps working", async () => {
    const old = path.join(managedOllamaRoot(), "0.30.0", EXE);
    mkdirSync(path.dirname(old), { recursive: true });
    writeFileSync(old, "older helper");
    useZip(fakeOllamaZip()); // the current pin is 0.0.0-test, not set up yet
    expect(managedOllamaBin()).toBe(old);
    const fresh = await installManagedOllama(sink(), undefined, serveBytes(fakeOllamaZip())); // set-up installs the new pin
    expect(fresh).toBe(path.join(managedOllamaRoot(), "0.0.0-test", EXE));
    expect(readdirSync(managedOllamaRoot())).toEqual(["0.0.0-test"]); // the old one is removed
  });

  it("a zip without the executable isn't set up", async () => {
    const zip = makeZip([{ name: "lib/ollama/ggml.dll", data: "x" }]);
    useZip(zip);
    await expect(installManagedOllama(sink(), undefined, serveBytes(zip))).rejects.toThrow(/couldn't set up the helper/);
    expect(managedOllamaBin()).toBeNull();
  });
});
