import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extraField, fakeOllamaZip, makeZip } from "../../e2e/zip-fixture.js";
import { readZipEntries } from "./zip-entries.js";

// Loop 047, checker iteration 2 (N-a): the zip's own file list is read strictly, so the system
// unzip can never see a name, file type, or entry this check didn't.

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "skovern-zip-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function read(bytes: Buffer) {
  const f = path.join(dir, "x.zip");
  writeFileSync(f, bytes);
  return readZipEntries(f);
}
const reasonOf = async (bytes: Buffer) => {
  const r = await read(bytes);
  return "reason" in r ? r.reason : null;
};

describe("readZipEntries accepts the plain shape Ollama's build has", () => {
  it("a plain zip lists every entry with its type", async () => {
    const r = await read(fakeOllamaZip());
    expect("entries" in r && r.entries.map((e) => e.name)).toEqual(["lib/", "lib/ollama/", "lib/ollama/ggml.dll", process.platform === "win32" ? "ollama.exe" : "ollama"]);
  });

  it("NTFS (0x000a) and extended (0x5455) timestamps are fine — the real zip carries 0x000a", async () => {
    const r = await read(makeZip([{ name: "a.dll", data: "x", extra: Buffer.concat([extraField(0x000a, Buffer.alloc(32)), extraField(0x5455, Buffer.alloc(5))]) }]));
    expect("entries" in r).toBe(true);
  });
});

describe("readZipEntries refuses anything another reader could see differently", () => {
  it.each([
    ["an Info-ZIP Unicode path field (0x7075) in the file list", { extra: extraField(0x7075, Buffer.from("\u0001xxxx../../evil.dll")) }, /extra field we don't accept \(0x7075\)/],
    ["an attribute field (0x6c78) in the local header", { localExtra: extraField(0x6c78) }, /extra field we don't accept \(0x6c78\)/],
    ["a data descriptor (bit 3)", { flags: 0x0008 }, /stored in a way we don't accept/],
    ["encryption (bit 0)", { flags: 0x0001 }, /stored in a way we don't accept/],
    ["a non-ASCII name", { rawName: Buffer.from([0x6c, 0x69, 0x62, 0x2f, 0xff, 0xfe]) }, /unusual characters/],
    ["a damaged extra field", { extra: Buffer.from([0x0a, 0x00, 0xff, 0x00]) }, /damaged extra field/],
  ] as const)("%s", async (_label, entry, reason) => {
    expect(await reasonOf(makeZip([{ name: "lib/a.dll", data: "x", ...entry }]))).toMatch(reason);
  });

  it("a comment after the end record (where a fake end record could hide)", async () => {
    expect(await reasonOf(makeZip([{ name: "a.dll", data: "x" }], { comment: "PK\u0005\u0006 decoy" }))).toMatch(/a comment or a damaged end/);
  });

  it("an end record whose count leaves entries unchecked", async () => {
    const z = makeZip([{ name: "a.dll", data: "x" }, { name: "b.dll", data: "y" }]);
    z.writeUInt16LE(1, z.length - 22 + 8);
    z.writeUInt16LE(1, z.length - 22 + 10);
    expect(await reasonOf(z)).toMatch(/damaged file list/);
  });

  it("bytes smuggled between the file list and the end record", async () => {
    const z = makeZip([{ name: "a.dll", data: "x" }]);
    const end = z.subarray(z.length - 22);
    expect(await reasonOf(Buffer.concat([z.subarray(0, z.length - 22), Buffer.from("junk"), end]))).toMatch(/damaged file list/);
  });

  it("a local header that points past the file list, or a truncated file", async () => {
    const z = makeZip([{ name: "a.dll", data: "x" }]);
    const cdStart = z.readUInt32LE(z.length - 22 + 16);
    z.writeUInt32LE(cdStart + 4, cdStart + 42); // the entry's local-header offset → inside the list
    expect(await reasonOf(z)).toMatch(/damaged file list/);
    expect(await reasonOf(Buffer.from("PK"))).toMatch(/damaged file list/);
  });
});
