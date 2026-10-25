// Release gate (release-updates loop): the tag, the app version, and the release notes agree
// before anything is built. Runs with plain Node (type stripping), no dependencies, so the
// release workflow can run it before `pnpm install`.
//
//   node apps/desktop/scripts/release-check.ts <tag> [--notes-out <file>]
//   node apps/desktop/scripts/release-check.ts --from-version [--notes-out <file>]   (dry runs)

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type ReleaseCheck = { ok: true; tag: string; notes: string } | { ok: false; reason: string };

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** The notes under `## v<version> — <YYYY-MM-DD>` in UPDATES.md, up to the next `## `. */
export function notesFor(updatesMd: string, version: string): string | null {
  const lines = updatesMd.split(/\r?\n/);
  const head = new RegExp(`^## v${version.replace(/\./g, "\\.")} — \\d{4}-\\d{2}-\\d{2}\\s*$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return body.length > 0 ? body : null;
}

export function checkRelease(input: { tag: string; version: string; updatesMd: string }): ReleaseCheck {
  const { tag, version, updatesMd } = input;
  const m = SEMVER.exec(version);
  if (!m) return { ok: false, reason: `apps/desktop/package.json version "${version}" is not x.y.z` };
  if (tag !== `v${version}`) return { ok: false, reason: `tag ${tag} doesn't match apps/desktop/package.json version ${version} (expected v${version})` };
  if (m[1] !== "0") return { ok: false, reason: `version ${version}: the major version stays 0 until the beta` };
  const notes = notesFor(updatesMd, version);
  if (notes === null) return { ok: false, reason: `UPDATES.md has no "## ${tag} — YYYY-MM-DD" entry with notes for ${tag}` };
  return { ok: true, tag, notes };
}

function main(argv: string[]): number {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const desktop = path.resolve(here, "..");
  const version = (JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8")) as { version?: unknown }).version;
  const updatesMd = readFileSync(path.resolve(desktop, "../../UPDATES.md"), "utf8");
  const outAt = argv.indexOf("--notes-out");
  const notesOut = outAt >= 0 ? argv[outAt + 1] : undefined;
  const tag = argv[0] === "--from-version" ? `v${String(version)}` : (argv[0] ?? "");
  const result = checkRelease({ tag, version: String(version), updatesMd });
  if (!result.ok) {
    console.error(`release check failed: ${result.reason}`);
    return 1;
  }
  if (notesOut) writeFileSync(notesOut, `${result.notes}\n`);
  console.log(`release check passed: ${result.tag}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
