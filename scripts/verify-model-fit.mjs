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
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const PKG = "@dawid-ai/model-fit";
const REPO = "dawid-ai/model-fit";
const WORKFLOW = `${REPO}/.github/workflows/publish.yml`;
// Anything that reaches outside pure math. A string in a comment is a false alarm worth having.
const FORBIDDEN = [/\brequire\s*\(/, /\bimport\s*\(/, /\bprocess\b/, /\bfetch\b/, /\beval\s*\(/, /\bFunction\s*\(/, /\bglobalThis\b/, /XMLHttpRequest/, /WebSocket/, /child_process/, /node:/];

// Throw rather than process.exit(): exiting with a fetch socket still open crashes Node on Windows.
const fail = (msg) => {
  throw new Error(msg);
};

const dir = mkdtempSync(path.join(tmpdir(), "model-fit-verify-"));
try {
  const lock = readFileSync("pnpm-lock.yaml", "utf8");
  const m = lock.match(/'@dawid-ai\/model-fit@(\d+\.\d+\.\d+)':\n\s+resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/);
  if (!m) fail("no locked version with an integrity hash in pnpm-lock.yaml");
  const [, version, integrity] = m;
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
      ["attestation", "verify", tgz, "--bundle", bundle, "--digest-alg", "sha512", "--repo", REPO, "--signer-workflow", WORKFLOW, "--source-ref", `refs/tags/v${version}`],
      { stdio: "pipe" },
    );
  } catch (e) {
    fail(`provenance does not verify for ${REPO} / publish.yml / v${version}:\n${e.stderr?.toString() ?? e.message}`);
  }

  execFileSync("tar", ["-xzf", tgz, "-C", dir]);
  const src = path.join(dir, "package", "dist", "src");
  const files = readdirSync(src).filter((f) => f.endsWith(".js"));
  if (files.length === 0) fail("no shipped JavaScript found in dist/src");
  for (const f of files) {
    const code = readFileSync(path.join(src, f), "utf8");
    for (const re of FORBIDDEN) if (re.test(code)) fail(`dist/src/${f} matches ${re} — the module must stay pure`);
  }
  const pkg = JSON.parse(readFileSync(path.join(dir, "package", "package.json"), "utf8"));
  for (const s of ["preinstall", "install", "postinstall", "prepare"]) if (pkg.scripts?.[s]) fail(`ships a "${s}" script`);
  if (Object.keys(pkg.dependencies ?? {}).length > 0) fail("ships runtime dependencies");

  console.log(`✔ ${PKG}@${version}: hash matches the lockfile, provenance verified (${REPO}, publish.yml, v${version}), ${files.length} files pure`);
} catch (e) {
  console.error(`✖ ${PKG}: ${e.message}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
