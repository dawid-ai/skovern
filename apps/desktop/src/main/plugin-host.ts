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
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}

function isMessage(raw: unknown): raw is ChildToHost {
  return typeof raw === "object" && raw !== null && typeof (raw as { type?: unknown }).type === "string";
}

export interface RunPluginDeps {
  manifest: PluginManifest;
  /** `brain` capability. The fixture uses only `fetch`; a stub throws if a skill asks. */
  brain: Router;
  /** DEV/TEST seam: allow http/loopback so the e2e can hit a local mock. Off in prod. */
  allowLoopback: boolean;
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
    const timer = setTimeout(() => finish({ ok: false, message: "That skill took too long." }), RUN_TIMEOUT_MS);
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
      // capability is an untrusted string; the broker denies anything the manifest
      // didn't grant, so the cast can't widen what actually runs.
      const resp = await broker.handle({ id: msg.reqId, capability: msg.capability as Capability, arg: msg.arg });
      inflight--;
      post({ type: "cap-result", reqId: msg.reqId, ok: resp.ok, result: resp.result, error: resp.error });
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
