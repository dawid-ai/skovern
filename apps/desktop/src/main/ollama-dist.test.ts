import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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

import { checkZipEntries, installManagedOllama, managedOllamaBin, managedOllamaRoot, ollamaDist, unsafeEntryReason } from "./ollama-dist.js";

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
  ])("%j → refused", (name, reason) => {
    expect(unsafeEntryReason(name)).toMatch(reason);
  });

  it("ordinary names pass, including dots that aren't '..'", () => {
    expect(checkZipEntries(["ollama.exe", "lib/", "lib/ollama/ggml.dll", "lib/ollama/..hidden", "a.b/c"])).toBeNull();
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

  it("M8: a zip carrying a symlink is never set up", async () => {
    const zip = makeZip([{ name: EXE, data: "x" }, { name: "lib/link", data: "../../..", symlink: true }]);
    useZip(zip);
    // On Linux the link unpacks and the after-check refuses it; on Windows the unzip itself may
    // refuse it. Either way: rejected, not set up, nothing left.
    await expect(installManagedOllama(sink(), undefined, serveBytes(zip))).rejects.toThrow(/a link|couldn't set up the helper/);
    expect(managedOllamaBin()).toBeNull();
    expect(readdirSync(managedOllamaRoot())).toEqual([]);
  });

  it("a zip without the executable isn't set up", async () => {
    const zip = makeZip([{ name: "lib/ollama/ggml.dll", data: "x" }]);
    useZip(zip);
    await expect(installManagedOllama(sink(), undefined, serveBytes(zip))).rejects.toThrow(/couldn't set up the helper/);
    expect(managedOllamaBin()).toBeNull();
  });
});
