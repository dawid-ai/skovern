#!/usr/bin/env node
// Supply-chain gate for @dawid-ai/model-fit (loop 046, SEC-046-1). The module runs in Electron's
// main process, so a bump must prove it came from Dawid's repo, not from a stolen npm token:
//   1. the tarball npm serves for the LOCKED version matches the lockfile's integrity hash;
//   2. its provenance is signed for github.com/dawid-ai/model-fit, built by publish.yml from the
//      matching v<version> tag (verified with `gh attestation verify`);
//   3. the code it ships is pure — no I/O, network, process, or dynamic code.
// Exit code 1 on any failure. Needs `gh` (authenticated, GH_TOKEN in CI), `tar`, and network.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PKG = "@dawid-ai/model-fit";
const REPO = "dawid-ai/model-fit";
const WORKFLOW = `${REPO}/.github/workflows/publish.yml`;
// Anything that reaches outside pure math. A string in a comment is a false alarm worth having.
const FORBIDDEN = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bprocess\b/,
  /\bfetch\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\.constructor\s*\(/,
  /\bglobalThis\b/,
  /XMLHttpRequest/,
  /WebSocket/,
  /child_process/,
  /node:/,
  // A bare import or re-export of a Node built-in (`from "fs"`), 046 checker iteration 9 N8.
  /\bfrom\s*["'](fs|fs\/promises|net|tls|dgram|dns|http|https|http2|os|path|child_process|worker_threads|cluster|vm|module|inspector)["']/,
];
// Every static import or re-export must be a relative path that stays inside the package, so no
// `electron`, `original-fs`, or any other package can reach the main process through it (SEC-046
// hardening 1). Like FORBIDDEN, this scan is a tripwire, not proof.
const IMPORT_SPEC = /\b(?:from|import)\s*["']([^"']*)["']/g;

// Throw rather than process.exit(): exiting with a fetch socket still open crashes Node on Windows.
const fail = (msg) => {
  throw new Error(msg);
};

// The one locked model-fit version and its hash. Every lockfile key for the package must name the
// same version, its resolution must be a registry integrity hash (no tarball URL, git, or file),
// and every importer must use that version, so the gate can't verify one version while another
// installs (SEC-046-2).
function lockedModelFit(lock) {
  const versions = [...new Set([...lock.matchAll(/^ {2}'@dawid-ai\/model-fit@([^']*)':/gm)].map((k) => k[1]))];
  if (versions.length !== 1) fail(`pnpm-lock.yaml must lock exactly one ${PKG} version, found ${versions.join(", ") || "none"}`);
  const [version] = versions;
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`locked version "${version}" isn't a plain release version`);
  const resolutions = [...lock.matchAll(/^ {2}'@dawid-ai\/model-fit@[^']*':\n {4}resolution: (.*)$/gm)].map((r) => r[1]);
  if (resolutions.length !== 1) fail(`expected one resolution for ${PKG}, found ${resolutions.length}`);
  const r = /^\{integrity: (sha512-[A-Za-z0-9+/]+={0,2})\}$/.exec(resolutions[0]);
  if (!r) fail(`${PKG} resolution isn't a registry integrity hash: ${resolutions[0]}`);
  const used = [...lock.matchAll(/^ {6}'@dawid-ai\/model-fit':\n {8}specifier: .*\n {8}version: (.*)$/gm)].map((u) => u[1]);
  if (used.length === 0) fail(`no importer uses ${PKG}`);
  const other = used.find((v) => v !== version);
  if (other !== undefined) fail(`an importer uses ${PKG} ${other}, not the verified ${version}`);
  return { version, integrity: r[1] };
}

// On Windows, Git Bash's tar can come first on PATH and reads "C:" as a remote host; use the
// system tar there (046 checker N4).
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";

// Every .js file under a dir, at any depth (046 checker N6).
const jsFiles = (root, rel = "") =>
  readdirSync(path.join(root, rel)).flatMap((f) => {
    const r = path.join(rel, f);
    return statSync(path.join(root, r)).isDirectory() ? jsFiles(root, r) : /\.[cm]?js$/.test(f) ? [r] : [];
  });

const dir = mkdtempSync(path.join(tmpdir(), "model-fit-verify-"));
try {
  const { version, integrity } = lockedModelFit(readFileSync("pnpm-lock.yaml", "utf8"));
  const tgz = path.join(dir, `model-fit-${version}.tgz`);
  const res = await fetch(`https://registry.npmjs.org/${PKG}/-/model-fit-${version}.tgz`);
  if (!res.ok) fail(`tarball download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (got !== integrity) fail(`tarball hash ${got} does not match the lockfile's ${integrity}`);
  writeFileSync(tgz, bytes);

  const att = await (await fetch(`https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(PKG)}@${version}`)).json();
  const prov = att.attestations?.find((a) => a.predicateType === "https://slsa.dev/provenance/v1");
  if (!prov) fail(`${version} has no SLSA provenance — it wasn't published from CI`);
  const bundle = path.join(dir, "provenance.json");
  writeFileSync(bundle, JSON.stringify(prov.bundle));
  try {
    execFileSync(
      "gh",
      ["attestation", "verify", tgz, "--bundle", bundle, "--digest-alg", "sha512", "--repo", REPO, "--signer-workflow", WORKFLOW, "--source-ref", `refs/tags/v${version}`, "--deny-self-hosted-runners"],
      { stdio: "pipe" },
    );
  } catch (e) {
    fail(`provenance does not verify for ${REPO} / publish.yml / v${version}:\n${e.stderr?.toString() ?? e.message}`);
  }

  execFileSync(TAR, ["-xzf", tgz, "-C", dir]);
  const root = path.join(dir, "package");
  const files = jsFiles(root);
  if (files.length === 0) fail("no shipped JavaScript found");
  // No bundled dependencies and no native code anywhere in the tarball (046 checker iteration 9).
  const everything = (rel = "") =>
    readdirSync(path.join(root, rel)).flatMap((f) => {
      const r = path.join(rel, f);
      return statSync(path.join(root, r)).isDirectory() ? [r, ...everything(r)] : [r];
    });
  for (const f of everything()) {
    if (f.split(/[\\/]/).includes("node_modules")) fail(`ships ${f}`);
    if (/\.(node|wasm)$/.test(f)) fail(`ships native code (${f})`);
  }
  for (const f of files) {
    const code = readFileSync(path.join(root, f), "utf8");
    for (const re of FORBIDDEN) if (re.test(code)) fail(`${f} matches ${re} — the module must stay pure`);
    for (const [, spec] of code.matchAll(IMPORT_SPEC)) {
      const target = path.relative(root, path.resolve(root, path.dirname(f), spec));
      if (!/^\.\.?\//.test(spec) || target.startsWith("..") || path.isAbsolute(target)) {
        fail(`${f} imports "${spec}" — only files inside the package are allowed`);
      }
    }
  }
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  // Every code entry point must resolve inside dist/src, so a repointed main can't dodge the scan.
  // Data exports (data/*.json) are fine anywhere.
  const entries = [pkg.main, pkg.module, ...JSON.stringify(pkg.exports ?? {}).match(/"\.\/[^"]+"/g) ?? []]
    .filter(Boolean)
    .map((e) => e.replace(/"/g, ""));
  if (pkg.bin) fail("ships a bin script");
  if (pkg.bundleDependencies || pkg.bundledDependencies) fail("bundles dependencies");
  for (const e of entries) {
    // Data and type files may sit anywhere; every other entry point must be JavaScript.
    if (/\.(json|d\.ts)$/.test(e)) continue;
    if (!/\.[cm]?js$/.test(e)) fail(`entry point ${e} isn't a .js file`);
    const rel = path.relative(path.join(root, "dist", "src"), path.join(root, e));
    if (rel.startsWith("..") || path.isAbsolute(rel)) fail(`entry point ${e} is outside dist/src`);
  }
  for (const s of ["preinstall", "install", "postinstall", "prepare"]) if (pkg.scripts?.[s]) fail(`ships a "${s}" script`);
  if (Object.keys(pkg.dependencies ?? {}).length > 0) fail("ships runtime dependencies");

  console.log(`✔ ${PKG}@${version}: hash matches the lockfile, provenance verified (${REPO}, publish.yml, v${version}), ${files.length} files pure`);
} catch (e) {
  console.error(`✖ ${PKG}: ${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
