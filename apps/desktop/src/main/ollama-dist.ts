import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, lstatSync } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FetchSink } from "@skovern/core";
import { DownloadError, SAFETY_FAILED, downloadVerified, type DownloadProgress } from "./download.js";

// Loop 047: Skovern sets up Ollama for a user who doesn't have it. We fetch Ollama's own
// command-line build (no tray app, no Startup shortcut, no PATH change, no self-updater) into
// Skovern's folder, and run it ourselves. The version, URL and sha256 are pinned HERE, in code —
// never in the catalog, which is unsigned (ledger `local-catalog-integrity-trust`). A new Ollama
// ships with an app update.

const execFileP = promisify(execFile);

export interface OllamaDist {
  version: string;
  url: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
}

// From github.com/ollama/ollama/releases/tag/v0.40.6 (2026-10-16): the asset digest and the
// release's sha256sum.txt agree. The zip carries CUDA, Vulkan (AMD/Intel) and CPU backends.
// ponytail: Windows x64 only; macOS/Linux set-up is loop 049.
const PINS: Partial<Record<string, OllamaDist>> = {
  "win32-x64": {
    version: "0.40.6",
    url: "https://github.com/ollama/ollama/releases/download/v0.40.6/ollama-windows-amd64.zip",
    sha256: "e359637575302f288d76c0007c408a4be9c7376d59c4f28684d63b232a44b427",
    sizeBytes: 1_471_164_488,
    filename: "ollama-windows-amd64.zip",
  },
};

/** The helper build Skovern can set up on this computer, or null when there's none for this
 *  platform. Unpackaged test seam (mirror of `SKOVERN_MODEL_DOWNLOAD_URL`): with
 *  `SKOVERN_OLLAMA_DIST_URL` + `SKOVERN_OLLAMA_DIST_SHA256` (+ optional `SKOVERN_OLLAMA_DIST_SIZE`)
 *  set, the BYTES come from that fixture and must match that hash; the url stays an https github
 *  link, so the https-only rule and the receipt's host are the real ones. A packaged app reads
 *  only the pin. */
export function ollamaDist(): OllamaDist | null {
  const sha256 = !app.isPackaged ? process.env["SKOVERN_OLLAMA_DIST_SHA256"] : undefined;
  if (sha256 && process.env["SKOVERN_OLLAMA_DIST_URL"]) {
    const size = Number(process.env["SKOVERN_OLLAMA_DIST_SIZE"]);
    return {
      version: "0.0.0-test",
      url: "https://github.com/ollama/ollama/releases/download/v0.0.0-test/ollama-test.zip",
      sha256,
      sizeBytes: Number.isFinite(size) && size > 0 ? size : 1024,
      filename: "ollama-test.zip",
    };
  }
  return PINS[`${process.platform}-${process.arch}`] ?? null;
}

// The fetch behind the helper download: the real one, or (unpackaged, seam set) one that reads the
// fixture's bytes instead.
function distFetch(): typeof fetch {
  const override = !app.isPackaged ? process.env["SKOVERN_OLLAMA_DIST_URL"] : undefined;
  return override ? (((_: unknown, init?: RequestInit) => fetch(override, init)) as typeof fetch) : fetch;
}

/** Where Skovern keeps the helper: `<userData>/ollama/<version>/`. App-owned, never user input. */
export function managedOllamaRoot(): string {
  return path.join(app.getPath("userData"), "ollama");
}

function exeName(): string {
  return process.platform === "win32" ? "ollama.exe" : "ollama";
}

/** The helper we set up, as an absolute path, or null if it isn't set up. Only a finished
 *  `<version>/` dir counts — a `.partial` never does. */
export function managedOllamaBin(): string | null {
  const dist = ollamaDist();
  if (!dist) return null;
  const bin = path.join(managedOllamaRoot(), dist.version, exeName());
  return existsSync(bin) ? bin : null;
}

/** Why a zip entry name is unsafe to unpack, or null when it's fine. Pure. Rejects anything that
 *  could land outside the target dir: `..` segments, absolute paths, drive letters, UNC paths. */
export function unsafeEntryReason(name: string): string | null {
  if (name.length === 0) return "an empty file name";
  if (name.includes("\0")) return "a file name with a null byte";
  if (/^[A-Za-z]:/.test(name)) return `a drive letter path (${name})`;
  if (name.startsWith("/") || name.startsWith("\\")) return `an absolute path (${name})`;
  if (name.split(/[\\/]/).some((seg) => seg === "..")) return `a path that climbs out of its folder (${name})`;
  return null;
}

/** The first unsafe entry's reason across a zip listing, or null. Pure. */
export function checkZipEntries(names: string[]): string | null {
  for (const n of names) {
    const r = unsafeEntryReason(n);
    if (r) return r;
  }
  return null;
}

/** After unpacking: every entry must be a plain file or folder that really sits inside `root`
 *  (no symlink or junction can point out). Returns the reason it isn't, or null. */
export function checkUnpacked(root: string): string | null {
  const base = path.resolve(root);
  const walk = (dir: string): string | null => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) return `a link (${path.relative(base, p)})`;
      const rel = path.relative(base, path.resolve(p));
      if (rel.startsWith("..") || path.isAbsolute(rel)) return `a file outside its folder (${p})`;
      if (st.isDirectory()) {
        const r = walk(p);
        if (r) return r;
      } else if (!st.isFile()) return `something that isn't a file (${path.relative(base, p)})`;
    }
    return null;
  };
  return walk(base);
}

// The system's own unzip, so there's no new dependency: Windows 10+ and macOS ship bsdtar (reads
// zip); Linux (CI) uses `unzip`. Fixed args, absolute paths we built, no shell.
function tarBin(): string {
  return process.platform === "win32" ? path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar";
}
async function listZip(zip: string): Promise<string[]> {
  const { stdout } =
    process.platform === "linux"
      ? await execFileP("unzip", ["-Z1", zip], { maxBuffer: 16 * 1024 * 1024 })
      : await execFileP(tarBin(), ["-tf", zip], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split(/\r?\n/).filter((l) => l.length > 0);
}
async function unpackZip(zip: string, dest: string): Promise<void> {
  if (process.platform === "linux") await execFileP("unzip", ["-q", "-o", zip, "-d", dest]);
  else await execFileP(tarBin(), ["-xf", zip, "-C", dest]);
}

const UNPACK_FAILED = "We couldn't set up the helper on this computer. Try again — if it keeps happening, restart Skovern.";

/** Download, verify, and unpack the helper. Returns the absolute path of its executable.
 *  The zip is sha256-gated before it's opened; its entry names are checked before unpacking; the
 *  result is checked again after; and only then is the `.partial` dir renamed into place. Any
 *  failure removes the partial dir. Old helper versions are removed on success. */
export async function installManagedOllama(
  sink: FetchSink,
  onProgress?: (p: DownloadProgress) => void,
  fetchImpl: typeof fetch = distFetch(),
): Promise<string> {
  const dist = ollamaDist();
  if (!dist) throw new DownloadError("Skovern can't set up the helper on this kind of computer yet.");
  const existing = managedOllamaBin();
  if (existing) return existing;

  const root = managedOllamaRoot();
  const zip = path.join(root, dist.filename);
  try {
    await downloadVerified(dist, zip, sink, onProgress, fetchImpl);
  } catch (err) {
    // The helper isn't a "model" — keep the safety-check wording honest.
    if (err instanceof DownloadError && err.message === SAFETY_FAILED) {
      throw new DownloadError("The helper download didn't match its safety check and was removed. Try again.");
    }
    throw err;
  }

  const final = path.join(root, dist.version);
  const partial = `${final}.partial`;
  await rm(partial, { recursive: true, force: true });
  try {
    const bad = checkZipEntries(await listZip(zip));
    if (bad) throw new DownloadError(`The helper download contained ${bad}, so it wasn't set up.`);
    await mkdir(partial, { recursive: true });
    await unpackZip(zip, partial);
    const after = checkUnpacked(partial);
    if (after) throw new DownloadError(`The helper download contained ${after}, so it wasn't set up.`);
    if (!existsSync(path.join(partial, exeName()))) throw new DownloadError(UNPACK_FAILED);
    await rm(final, { recursive: true, force: true });
    await rename(partial, final);
  } catch (err) {
    await rm(partial, { recursive: true, force: true }).catch(() => {});
    throw err instanceof DownloadError ? err : new DownloadError(UNPACK_FAILED);
  } finally {
    await rm(zip, { force: true }).catch(() => {});
  }

  // Keep only the version we just set up.
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (name !== dist.version && !name.endsWith(".zip.part")) await rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
  }
  return path.join(final, exeName());
}
