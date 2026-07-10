import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Fast plain-node proxy for the sandbox (the binding proof is the real Electron
// utilityProcess in skills.spec.ts). It runs Node with the SAME Permission Model
// flags the host uses and asserts a child: (1) can read inside its granted dir,
// (2) is DENIED reading outside it, (3) is DENIED spawning a subprocess.

function permissionFlag(): string {
  const [maj, min] = process.versions.node.split(".").map((n) => parseInt(n, 10));
  const stable = maj! > 23 || (maj === 23 && (min ?? 0) >= 5);
  return stable ? "--permission" : "--experimental-permission";
}

const PROBE = [
  "const fs=require('node:fs');",
  "const cp=require('node:child_process');",
  "let out='';",
  "try{fs.readFileSync(process.argv[2],'utf8');out+='IN_OK ';}catch(e){out+='IN_'+((e&&e.code)||'ERR')+' ';}",
  "try{fs.readFileSync(process.argv[1],'utf8');out+='OUT_OK ';}catch(e){out+='OUT_'+((e&&e.code)||'ERR')+' ';}",
  "try{const r=cp.spawnSync(process.execPath,['-e','0']);out+='SPAWN_'+((r.error&&r.error.code)||(r.status===0?'OK':'ERR'));}catch(e){out+='SPAWN_'+((e&&e.code)||'ERR');}",
  "console.log(out);",
].join("");

describe("Node Permission Model sandbox", () => {
  it("denies fs-read outside the plugin dir and denies subprocess, but allows in-dir read", () => {
    const grantedDir = mkdtempSync(path.join(tmpdir(), "dh-granted-"));
    const outsideDir = mkdtempSync(path.join(tmpdir(), "dh-outside-"));
    const grantedFile = path.join(grantedDir, "ok.txt");
    const outsideFile = path.join(outsideDir, "secret.txt");
    writeFileSync(grantedFile, "in-scope");
    writeFileSync(outsideFile, "must-not-read");

    const r = spawnSync(
      process.execPath,
      [permissionFlag(), `--allow-fs-read=${grantedDir}`, "-e", PROBE, outsideFile, grantedFile],
      { encoding: "utf8" },
    );

    const out = r.stdout ?? "";
    expect(out).toContain("IN_OK"); // scoping is real, not a blanket deny
    expect(out).toContain("OUT_ERR_ACCESS_DENIED"); // outside read denied
    expect(out).toContain("SPAWN_ERR_ACCESS_DENIED"); // subprocess denied
  });
});
