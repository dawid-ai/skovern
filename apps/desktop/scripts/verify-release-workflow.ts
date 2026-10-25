// Shape rules for .github/workflows/release.yml (release-updates loop, M6). The job that can
// publish holds the write token, so it must run no repository or npm code, and nothing else
// may hold a write permission. Every failure names its rule.
//
//   node apps/desktop/scripts/verify-release-workflow.ts [path/to/release.yml]

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

const PINNED = /@[0-9a-f]{40}$/;
const NPM_CODE = /\b(pnpm|npm|npx|node|yarn|corepack|bun|deno)\b/;
const PUBLISH_ACTIONS = ["actions/download-artifact@", "actions/attest-build-provenance@"];
const PUBLISH_PERMISSIONS = { contents: "write", "id-token": "write", attestations: "write" };

function stepsOf(job: Obj): Obj[] {
  return asList(job["steps"]).filter(isObj);
}

export function checkWorkflow(text: string): string[] {
  const errors: string[] = [];
  const doc: unknown = parse(text);
  if (!isObj(doc)) return ["R0: not a workflow"];
  // YAML 1.1 reads a bare `on:` key as the boolean true.
  const on = doc["on"] ?? (doc as Record<string, unknown>)["true"];
  const jobs = isObj(doc["jobs"]) ? doc["jobs"] : {};

  // R1: triggers — v* tags, pull requests (dry run), manual runs (dry run). Nothing else.
  if (!isObj(on)) errors.push("R1: triggers must be a map");
  else {
    const extra = Object.keys(on).filter((k) => !["push", "pull_request", "workflow_dispatch"].includes(k));
    if (extra.length) errors.push(`R1: unexpected trigger(s): ${extra.join(", ")}`);
    const push = on["push"];
    if (!isObj(push) || JSON.stringify(Object.keys(push)) !== '["tags"]' || JSON.stringify(push["tags"]) !== '["v*"]')
      errors.push('R1: push must trigger on tags ["v*"] only');
  }

  // R2: the workflow's default token is read-only.
  if (!isObj(doc["permissions"]) || JSON.stringify(doc["permissions"]) !== '{"contents":"read"}')
    errors.push("R2: top-level permissions must be exactly contents: read");

  // R3: the three jobs, in order.
  const check = jobs["check"], build = jobs["build-win"], publish = jobs["publish"];
  if (!isObj(check) || !isObj(build) || !isObj(publish)) {
    errors.push("R3: jobs check, build-win, and publish must all exist");
    return errors;
  }
  if (!asList(build["needs"]).includes("check")) errors.push("R3: build-win must need check");
  if (!asList(publish["needs"]).includes("build-win")) errors.push("R3: publish must need build-win");

  // R4: only publish may write or mint an OIDC token.
  for (const [name, job] of Object.entries(jobs)) {
    if (name === "publish" || !isObj(job)) continue;
    const perms = job["permissions"];
    if (perms === undefined) continue; // inherits the read-only default
    if (!isObj(perms) || Object.values(perms).some((v) => v !== "read" && v !== "none"))
      errors.push(`R4: job ${name} may not hold a write permission or id-token`);
  }

  // R5: publish runs no repository or npm code.
  for (const step of stepsOf(publish)) {
    const uses = typeof step["uses"] === "string" ? step["uses"] : "";
    const run = typeof step["run"] === "string" ? step["run"] : "";
    if (uses && !PUBLISH_ACTIONS.some((a) => uses.startsWith(a))) errors.push(`R5: publish may not use ${uses.split("@")[0]}`);
    if (NPM_CODE.test(run)) errors.push(`R5: publish may not run npm or repository code (${run.match(NPM_CODE)?.[0]})`);
    if (step["shell"] !== undefined && step["shell"] !== "bash") errors.push(`R5: publish steps run in bash only (found shell: ${String(step["shell"])})`);
  }
  // A `defaults.run.shell` (workflow or job) could turn every `run:` into, say, node.
  if (doc["defaults"] !== undefined || publish["defaults"] !== undefined) errors.push("R5: no defaults block may change how publish runs its steps");

  // R6: publish runs only for a pushed v* tag (pull requests and manual runs are dry runs).
  // Exact, so `… || always()` can't widen it.
  const cond = typeof publish["if"] === "string" ? publish["if"].replace(/\s+/g, " ").trim() : "";
  if (cond !== "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')") errors.push("R6: publish must run only on a pushed v* tag");

  // R7: every action pinned to a full commit SHA.
  for (const [name, job] of Object.entries(jobs)) {
    if (!isObj(job)) continue;
    for (const step of stepsOf(job)) {
      const uses = step["uses"];
      if (typeof uses === "string" && !PINNED.test(uses)) errors.push(`R7: ${name} uses ${uses}, not pinned to a commit SHA`);
    }
  }

  // R8: publish checks the installer against latest.yml before uploading it. The step must hash
  // the installer and fail on its own line for an empty value or either mismatch (top-level
  // sha512 and files[0].sha512, the one electron-updater verifies).
  const publishSteps = stepsOf(publish);
  const verifyAt = publishSteps.findIndex((s) => /sha512/i.test(String(s["name"] ?? "")));
  const uploadAt = publishSteps.findIndex((s) => /gh release upload/.test(String(s["run"] ?? "")));
  if (verifyAt < 0) errors.push("R8: publish must check the installer's sha512 against latest.yml");
  else {
    const run = String(publishSteps[verifyAt]!["run"] ?? "");
    const guards = ["openssl dgst -sha512 -binary Skovern-Setup.exe", '[ -n "$want" ] || {', '[ "$want" = "$got" ] || {', '[ "$file_want" = "$got" ] || {'];
    for (const g of guards) if (!run.includes(g)) errors.push(`R8: the sha512 check must include: ${g}`);
    if (uploadAt >= 0 && uploadAt < verifyAt) errors.push("R8: the sha512 check must come before the upload");
  }

  // R9: publish holds exactly what it needs.
  if (JSON.stringify(publish["permissions"]) !== JSON.stringify(PUBLISH_PERMISSIONS))
    errors.push("R9: publish permissions must be exactly contents: write, id-token: write, attestations: write");

  // R10: the installer is built on Windows and the packaged-app checks run before upload.
  if (build["runs-on"] !== "windows-latest") errors.push("R10: build-win must run on windows-latest");
  const pkg = stepsOf(build).find((s) => /test:packaging/.test(String(s["run"] ?? "")));
  if (!pkg) errors.push("R10: build-win must run test:packaging");
  else if (!isObj(pkg["env"]) || pkg["env"]["SKOVERN_REQUIRE_PACKAGED"] !== "1")
    errors.push("R10: test:packaging must set SKOVERN_REQUIRE_PACKAGED: \"1\" (a missing build fails instead of skipping)");
  if (stepsOf(build).some((s) => /--publish (always|onTag|onTagOrDraft)/.test(String(s["run"] ?? ""))))
    errors.push("R10: build-win may not publish");

  return errors;
}

function main(argv: string[]): number {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = argv[0] ?? path.resolve(here, "../../../.github/workflows/release.yml");
  const errors = checkWorkflow(readFileSync(file, "utf8"));
  for (const e of errors) console.error(e);
  if (errors.length === 0) console.log("release workflow shape: ok");
  return errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
