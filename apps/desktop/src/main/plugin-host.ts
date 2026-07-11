import { app } from "electron";
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBroker, type Router } from "@deskhand/core";
import type { Capability, PluginManifest } from "@deskhand/plugin-sdk";
import { createFetchUrl } from "./fetchurl.js";
import { fileFetchSink } from "./receipts.js";
import type { RunSkillResult, SandboxCheckResult } from "../shared/plugin.js";
import type { ChildToHost, HostToChild } from "../shared/plugin-rpc.js";

// The sandboxed host. A skill runs in a child locked down by Node's Permission Model
// (fs-read scoped to its own dir, no subprocess). Electron's `utilityProcess` silently
// IGNORES the permission flags (proven at 012b BUILD — the model never activates), so
// the child is the SHIPPED Electron binary re-launched via child_process in
// ELECTRON_RUN_AS_NODE mode, where the flags DO take effect. The child holds NO powers
// — each capability call is an RPC the 012a broker authorizes against the manifest. The
// host owns the id map: replies are matched to the host's own `runId`, so a compromised
// child can't spoof a result for another call.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHILD_ENTRY = path.join(__dirname, "plugin-child.mjs");
// The child's own bundled code: its entry + any shared chunks it imports (the
// manifest is shared with the host — single source of truth). Reading its OWN code
// is not an escalation; user files, the receipts log, and everything else stay out.
const CHILD_CHUNKS = path.join(__dirname, "chunks");

const MAX_ARG_BYTES = 64 * 1024;
const MAX_INFLIGHT = 4;
const RUN_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 15_000;

let runCounter = 0;

function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

// Node renamed --experimental-permission → --permission in 23.5. Electron 43 bundles
// Node ≈22 (experimental); repo Node 24 uses the stable flag. Pick by the runtime we
// actually spawn under so the sandbox proof matches what ships.
function permissionFlag(): string {
  const [maj, min] = process.versions.node.split(".").map((n) => parseInt(n, 10));
  const stable = maj! > 23 || (maj === 23 && (min ?? 0) >= 5);
  return stable ? "--permission" : "--experimental-permission";
}

function pluginDir(id: string): string {
  const dir = path.join(app.getPath("userData"), "plugins", id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Only the OS vars the forked binary needs to boot — never the user's ambient shell
// environment. The Permission Model locks fs+subprocess but NOT process.env, so
// inheriting it would hand an untrusted skill any exported secret (AWS_*, tokens) to
// exfiltrate through its granted fetch (whose receipt logs only the host). The child
// reads no env of its own, so this allowlist is safe.
const CHILD_ENV_ALLOW = [
  "SystemRoot", "SystemDrive", "windir", "PATH", "Path", "PATHEXT", "COMSPEC", "TEMP",
  "TMP", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "HOME", "USERPROFILE", "LANG", "LC_ALL",
];

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const k of CHILD_ENV_ALLOW) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

function spawnChild(dir: string): ChildProcess {
  // Grant read to the child's own bundled code (entry + shared chunks, so it can load)
  // and to the plugin's dir (its world) — nothing else. Subprocess is denied by default
  // under the model. ELECTRON_RUN_AS_NODE turns the shipped Electron binary into plain
  // Node, where the Permission Model actually activates.
  return fork(CHILD_ENTRY, [], {
    execPath: process.execPath,
    execArgv: [
      permissionFlag(),
      `--allow-fs-read=${CHILD_ENTRY}`,
      `--allow-fs-read=${CHILD_CHUNKS}`,
      `--allow-fs-read=${dir}`,
    ],
    env: childEnv(),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

function isMessage(raw: unknown): raw is ChildToHost {
  return typeof raw === "object" && raw !== null && typeof (raw as { type?: unknown }).type === "string";
}

// Progress is the FIRST child→host *notification* (all prior traffic was request/reply),
// so the child's message is untrusted input crossing the trust boundary. Validate it
// here, pure and unit-testable (no fork): forward ONLY a clean {step,total} when the
// echoed runId matches the host-owned active run and the two counters are sane integers
// (1 ≤ step ≤ total ≤ cap). Anything else → null (drop, no throw). The returned object
// carries EXACTLY {step,total} — no key from the raw message can ride the channel.
const MAX_PROGRESS_TOTAL = 1000;

export function validateProgress(raw: unknown, activeRunId: number): { step: number; total: number } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as { runId?: unknown; step?: unknown; total?: unknown };
  if (m.runId !== activeRunId) return null; // spoofed / stale id → not this run
  const { step, total } = m;
  if (!Number.isInteger(step) || !Number.isInteger(total)) return null; // NaN/Infinity/float rejected
  const s = step as number;
  const t = total as number;
  if (t < 1 || t > MAX_PROGRESS_TOTAL) return null;
  if (s < 1 || s > t) return null;
  return { step: s, total: t };
}

export interface RunPluginDeps {
  manifest: PluginManifest;
  /** `brain` capability. The fixture uses only `fetch`; a stub throws if a skill asks. */
  brain: Router;
  /** DEV/TEST seam: allow http/loopback so the e2e can hit a local mock. Off in prod. */
  allowLoopback: boolean;
  /** Override the whole-run cap. The CLI brain is slow per call, so a multi-call skill
   *  needs more than the default 30s. Still bounded — a hung skill can't run forever. */
  runTimeoutMs?: number;
  /** Optional UI sink for validated progress ("step N of total"). The host forwards
   *  only clean, runId-matched integers here (see `validateProgress`); it stays
   *  UI-agnostic — the caller decides where the two numbers go. */
  onProgress?: (step: number, total: number) => void;
}

export function runPlugin(deps: RunPluginDeps, input: string): Promise<RunSkillResult> {
  const dir = pluginDir(deps.manifest.id);
  // Give the plugin dir real content (its own manifest) — the scoped fs-read has
  // something legitimate to cover, and installers land the same file here later.
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(deps.manifest));

  const broker = createBroker({
    manifest: deps.manifest,
    brain: deps.brain,
    fetchUrl: createFetchUrl({ allowLoopback: deps.allowLoopback }),
    fetchSink: fileFetchSink(),
    allowLoopback: deps.allowLoopback,
  });

  const child = spawnChild(dir);
  const runId = ++runCounter; // host-owned; the child's echoed id is never trusted as the key
  let inflight = 0;

  return new Promise<RunSkillResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish({ ok: false, message: "That skill took too long." }), deps.runTimeoutMs ?? RUN_TIMEOUT_MS);
    function finish(r: RunSkillResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(r);
    }
    function post(m: HostToChild): void {
      try {
        child.send(m);
      } catch {
        /* child gone; the exit handler resolves */
      }
    }

    child.on("message", (raw: unknown) => {
      if (!isMessage(raw)) return;
      if (raw.type === "ready") {
        post({ type: "run", runId, pluginId: deps.manifest.id, input });
        return;
      }
      if (raw.type === "result") {
        if (raw.runId !== runId) return; // spoofed / stale id → ignore
        finish(raw.ok ? { ok: true, message: "Done.", result: raw.output ?? "" } : { ok: false, message: "That skill couldn't finish." });
        return;
      }
      if (raw.type === "progress") {
        // Validated at the trust boundary — a bad/stale/flooded progress is dropped
        // silently, never thrown, never forwarded to the renderer.
        const clean = validateProgress(raw, runId);
        if (clean) deps.onProgress?.(clean.step, clean.total);
        return;
      }
      if (raw.type === "cap") {
        void handleCap(raw);
      }
    });
    child.on("exit", () => finish({ ok: false, message: "That skill stopped unexpectedly." }));

    async function handleCap(msg: Extract<ChildToHost, { type: "cap" }>): Promise<void> {
      if (typeof msg.reqId !== "number" || typeof msg.capability !== "string" || typeof msg.arg !== "string") return;
      if (bytes(msg.arg) > MAX_ARG_BYTES) {
        post({ type: "cap-result", reqId: msg.reqId, ok: false, error: "That request was too big." });
        return;
      }
      if (inflight >= MAX_INFLIGHT) {
        post({ type: "cap-result", reqId: msg.reqId, ok: false, error: "Too many requests at once." });
        return;
      }
      inflight++;
      try {
        // capability is an untrusted string; the broker denies anything the manifest
        // didn't grant, so the cast can't widen what actually runs.
        const resp = await broker.handle({ id: msg.reqId, capability: msg.capability as Capability, arg: msg.arg });
        post({ type: "cap-result", reqId: msg.reqId, ok: resp.ok, result: resp.result, error: resp.error });
      } catch {
        // broker.handle rejects only if the fail-closed egress receipt couldn't be
        // written (disk full / EACCES). Egress stayed blocked; tell the child cleanly
        // instead of leaking an unhandled rejection and hanging it until timeout.
        post({ type: "cap-result", reqId: msg.reqId, ok: false, error: "That skill's request couldn't be completed." });
      } finally {
        inflight--;
      }
    }
  });
}

// Prove the sandbox through the REAL host: fork the child and ask it to try the two
// forbidden things (read a file outside its dir, spawn a subprocess). Returns which
// were denied — the e2e asserts both, so the guarantee is observed on what ships.
export function sandboxCheck(): Promise<SandboxCheckResult> {
  const dir = pluginDir("hello");
  const outside = path.join(app.getPath("userData"), "sandbox-probe-target.txt");
  writeFileSync(outside, "a file the skill must not be able to read"); // exists → denial is unambiguous, not ENOENT
  const child = spawnChild(dir);
  const runId = ++runCounter;

  return new Promise<SandboxCheckResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish({ fsReadDenied: false, spawnDenied: false }), PROBE_TIMEOUT_MS);
    function finish(r: SandboxCheckResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(r);
    }
    child.on("message", (raw: unknown) => {
      if (!isMessage(raw)) return;
      if (raw.type === "ready") {
        child.send({ type: "sandbox-probe", runId, outsidePath: outside });
        return;
      }
      if (raw.type === "sandbox-result" && raw.runId === runId) {
        finish({ fsReadDenied: raw.fsReadDenied, spawnDenied: raw.spawnDenied, detail: raw.detail });
      }
    });
    child.on("exit", () => finish({ fsReadDenied: false, spawnDenied: false }));
  });
}
