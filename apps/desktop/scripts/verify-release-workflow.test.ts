import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { checkWorkflow } from "./verify-release-workflow.js";

// release-updates M6: the real release.yml passes, and each mutation that would let the
// publishing job run npm code, widen a token, or skip a check fails with its own rule.

const REAL = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.github/workflows/release.yml"), "utf8");

type Wf = { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, { needs?: string; if?: string; permissions?: Record<string, string>; steps: Record<string, unknown>[]; "runs-on"?: string }> };
function mutate(fn: (wf: Wf) => void): string {
  const wf = parse(REAL) as Wf;
  fn(wf);
  return stringify(wf);
}

describe("release workflow shape", () => {
  it("the real release.yml passes every rule", () => {
    expect(checkWorkflow(REAL)).toEqual([]);
  });

  it("R5: publish running pnpm install fails", () => {
    const text = mutate((wf) => wf.jobs["publish"]!.steps.push({ run: "pnpm install --frozen-lockfile" }));
    expect(checkWorkflow(text)).toContain("R5: publish may not run npm or repository code (pnpm)");
  });

  it("R5: publish checking out the repository fails", () => {
    const text = mutate((wf) => wf.jobs["publish"]!.steps.unshift({ uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" }));
    expect(checkWorkflow(text)).toContain("R5: publish may not use actions/checkout");
  });

  it("R5: a node script in publish fails", () => {
    const text = mutate((wf) => wf.jobs["publish"]!.steps.push({ run: "node scripts/anything.mjs" }));
    expect(checkWorkflow(text)).toContain("R5: publish may not run npm or repository code (node)");
  });

  it("R4: a write token on check or build-win fails", () => {
    expect(checkWorkflow(mutate((wf) => (wf.jobs["check"]!.permissions = { contents: "write" })))).toContain("R4: job check may not hold a write permission or id-token");
    expect(checkWorkflow(mutate((wf) => (wf.jobs["build-win"]!.permissions = { contents: "read", "id-token": "write" })))).toContain(
      "R4: job build-win may not hold a write permission or id-token",
    );
  });

  it("R2: a write default token fails", () => {
    expect(checkWorkflow(mutate((wf) => (wf.permissions = { contents: "write" })))).toContain("R2: top-level permissions must be exactly contents: read");
  });

  it("R7: an action pinned by tag fails", () => {
    const text = mutate((wf) => (wf.jobs["build-win"]!.steps[0]!["uses"] = "actions/checkout@v4"));
    expect(checkWorkflow(text)).toContain("R7: build-win uses actions/checkout@v4, not pinned to a commit SHA");
  });

  it("R1: an extra trigger or a branch push fails", () => {
    expect(checkWorkflow(mutate((wf) => (wf.on["pull_request_target"] = {})))).toContain("R1: unexpected trigger(s): pull_request_target");
    expect(checkWorkflow(mutate((wf) => (wf.on["push"] = { tags: ["v*"], branches: ["main"] })))).toContain('R1: push must trigger on tags ["v*"] only');
  });

  it("R3/R6: publish without needs, or without the tag-only condition, fails", () => {
    expect(checkWorkflow(mutate((wf) => delete wf.jobs["publish"]!.needs))).toContain("R3: publish must need build-win");
    expect(checkWorkflow(mutate((wf) => delete wf.jobs["publish"]!.if))).toContain("R6: publish must run only on a pushed v* tag");
    expect(checkWorkflow(mutate((wf) => (wf.jobs["publish"]!.if = "github.event_name == 'push'")))).toContain("R6: publish must run only on a pushed v* tag");
  });

  // Checker iteration 1: each of these passed the old substring rules.
  it("R6: a condition widened with || always() fails", () => {
    const text = mutate((wf) => (wf.jobs["publish"]!.if = "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v') || always()"));
    expect(checkWorkflow(text)).toContain("R6: publish must run only on a pushed v* tag");
  });

  it("R5: a defaults block or a non-bash shell in publish fails", () => {
    const jobDefaults = mutate((wf) => ((wf.jobs["publish"] as Record<string, unknown>)["defaults"] = { run: { shell: "node {0}" } }));
    expect(checkWorkflow(jobDefaults)).toContain("R5: no defaults block may change how publish runs its steps");
    const topDefaults = mutate((wf) => ((wf as unknown as Record<string, unknown>)["defaults"] = { run: { shell: "node {0}" } }));
    expect(checkWorkflow(topDefaults)).toContain("R5: no defaults block may change how publish runs its steps");
    const stepShell = mutate((wf) => (wf.jobs["publish"]!.steps.find((s) => /sha512/i.test(String(s["name"] ?? "")))!["shell"] = "python"));
    expect(checkWorkflow(stepShell)).toContain("R5: publish steps run in bash only (found shell: python)");
  });

  it("R8: a sha512 step that doesn't really compare fails", () => {
    const echoOnly = mutate((wf) => (wf.jobs["publish"]!.steps.find((s) => /sha512/i.test(String(s["name"] ?? "")))!["run"] = 'want=$(sed -n "s/^sha512: //p" latest.yml)\necho "$want"'));
    const errors = checkWorkflow(echoOnly);
    expect(errors).toContain('R8: the sha512 check must include: [ -n "$want" ] || {');
    expect(errors).toContain('R8: the sha512 check must include: [ "$want" = "$got" ] || {');
    expect(errors).toContain('R8: the sha512 check must include: [ "$file_want" = "$got" ] || {');
  });

  // SECURE iteration 1: more ways to run code or fetch another run's files next to the token.
  it("R5: publish env (BASH_ENV), extra step env, or another run's artifacts fail", () => {
    const jobEnv = mutate((wf) => ((wf.jobs["publish"] as Record<string, unknown>)["env"] = { BASH_ENV: "dist/x.sh" }));
    expect(checkWorkflow(jobEnv)).toContain("R5: publish may not set job env");
    const stepEnv = mutate((wf) => (wf.jobs["publish"]!.steps.find((s) => /sha512/i.test(String(s["name"] ?? "")))!["env"] = { BASH_ENV: "dist/x.sh" }));
    expect(checkWorkflow(stepEnv)).toContain("R5: publish steps may set only GH_TOKEN: ${{ github.token }}");
    const otherRun = mutate((wf) => ((wf.jobs["publish"]!.steps[0]!["with"] as Record<string, string>)["run-id"] = "123"));
    expect(checkWorkflow(otherRun)).toContain("R5: download-artifact may take only name and path (found run-id)");
  });

  it("R8: a sha512 check that can't fail fails", () => {
    const sha = (wf: Wf) => wf.jobs["publish"]!.steps.find((s) => /sha512/i.test(String(s["name"] ?? "")))!;
    const early = mutate((wf) => (sha(wf)["run"] = "exit 0\n" + String(sha(wf)["run"])));
    expect(checkWorkflow(early)).toContain("R8: the sha512 check must start with set -eu");
    expect(checkWorkflow(early)).toContain("R8: the sha512 check may not exit 0, || true, or set +e");
    const orTrue = mutate((wf) => (sha(wf)["run"] = String(sha(wf)["run"]).replace("grep -qx \"path: Skovern-Setup.exe\" latest.yml", "grep -qx \"path: Skovern-Setup.exe\" latest.yml || true")));
    expect(checkWorkflow(orTrue)).toContain("R8: the sha512 check may not exit 0, || true, or set +e");
  });

  it("R10: packaged checks that may skip fail", () => {
    const text = mutate((wf) => delete (wf.jobs["build-win"]!.steps.find((s) => /test:packaging/.test(String(s["run"] ?? "")))!["env"] as Record<string, string>)["SKOVERN_REQUIRE_PACKAGED"]);
    expect(checkWorkflow(text)).toContain('R10: test:packaging must set SKOVERN_REQUIRE_PACKAGED: "1" (a missing build fails instead of skipping)');
  });

  it("R8: publish without the sha512 check, or with it after the upload, fails", () => {
    const noCheck = mutate((wf) => (wf.jobs["publish"]!.steps = wf.jobs["publish"]!.steps.filter((s) => !/sha512/i.test(String(s["name"] ?? "")))));
    expect(checkWorkflow(noCheck)).toContain("R8: publish must check the installer's sha512 against latest.yml");
    const late = mutate((wf) => {
      const steps = wf.jobs["publish"]!.steps;
      const i = steps.findIndex((s) => /sha512/i.test(String(s["name"] ?? "")));
      steps.push(steps.splice(i, 1)[0]!);
    });
    expect(checkWorkflow(late)).toContain("R8: the sha512 check must come before the upload");
  });

  it("R9: publish with an extra permission fails", () => {
    const text = mutate((wf) => (wf.jobs["publish"]!.permissions = { contents: "write", "id-token": "write", attestations: "write", packages: "write" }));
    expect(checkWorkflow(text)).toContain("R9: publish permissions must be exactly contents: write, id-token: write, attestations: write");
  });

  it("R10: build-win off Windows, without the packaged checks, or publishing itself fails", () => {
    expect(checkWorkflow(mutate((wf) => (wf.jobs["build-win"]!["runs-on"] = "ubuntu-latest")))).toContain("R10: build-win must run on windows-latest");
    const noPkg = mutate((wf) => (wf.jobs["build-win"]!.steps = wf.jobs["build-win"]!.steps.filter((s) => !/test:packaging/.test(String(s["run"] ?? "")))));
    expect(checkWorkflow(noPkg)).toContain("R10: build-win must run test:packaging");
    const self = mutate((wf) => wf.jobs["build-win"]!.steps.push({ run: "pnpm exec electron-builder --win --publish always" }));
    expect(checkWorkflow(self)).toContain("R10: build-win may not publish");
  });
});
