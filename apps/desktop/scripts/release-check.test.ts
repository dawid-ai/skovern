import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkRelease, notesFor } from "./release-check.js";

// release-updates M1: a release can't be cut with a mismatched tag, a 1.x version before the
// beta, or no notes. Each failure names what's wrong.

const MD = `# Skovern updates

## v0.1.1 — 2026-10-26

- Smaller fix.

## v0.1.0 — 2026-10-25

- Skovern updates itself.
- You can check for updates in Settings.

## v0.0.9 — 2026-10-01
`;

describe("release check", () => {
  it("passes a well-formed v0.1.0 and returns its notes", () => {
    expect(checkRelease({ tag: "v0.1.0", version: "0.1.0", updatesMd: MD })).toEqual({
      ok: true,
      tag: "v0.1.0",
      notes: "- Skovern updates itself.\n- You can check for updates in Settings.",
    });
  });

  it("fails when the tag doesn't match the package version, naming both", () => {
    expect(checkRelease({ tag: "v0.1.2", version: "0.1.0", updatesMd: MD })).toEqual({
      ok: false,
      reason: "tag v0.1.2 doesn't match apps/desktop/package.json version 0.1.0 (expected v0.1.0)",
    });
  });

  it("fails a 1.x version: it stays 0 until the beta", () => {
    const r = checkRelease({ tag: "v1.0.0", version: "1.0.0", updatesMd: "## v1.0.0 — 2026-12-01\n- Beta." });
    expect(r).toEqual({ ok: false, reason: "version 1.0.0: the major version stays 0 until the beta" });
  });

  it("fails when UPDATES.md has no entry, or an empty one, naming the tag", () => {
    expect(checkRelease({ tag: "v0.2.0", version: "0.2.0", updatesMd: MD })).toEqual({
      ok: false,
      reason: 'UPDATES.md has no "## v0.2.0 — YYYY-MM-DD" entry with notes for v0.2.0',
    });
    expect(notesFor(MD, "0.0.9")).toBeNull(); // heading with no notes
  });

  it("fails a version that isn't x.y.z, and doesn't match a look-alike heading", () => {
    expect(checkRelease({ tag: "v0.1", version: "0.1", updatesMd: MD })).toMatchObject({ ok: false, reason: 'apps/desktop/package.json version "0.1" is not x.y.z' });
    expect(notesFor("## v0x1x0 — 2026-10-25\n- no", "0.1.0")).toBeNull();
  });

  it("the CLI checks the real package.json and UPDATES.md and writes the notes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "skovern-relcheck-"));
    try {
      const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "release-check.ts");
      const out = path.join(dir, "notes.md");
      execFileSync(process.execPath, [script, "--from-version", "--notes-out", out]);
      expect(readFileSync(out, "utf8").trim().length).toBeGreaterThan(0);
      expect(() => execFileSync(process.execPath, [script, "v9.9.9"], { stdio: "pipe" })).toThrow(/doesn't match/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
