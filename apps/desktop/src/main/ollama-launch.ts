import { app } from "electron";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OllamaLaunch } from "../shared/settings.js";

// Ollama is an OPTIONAL upgrade, never a requirement. This module detects whether it's
// installed and — only with the user's consent (`ollamaLaunch: "always"`) — starts it. The
// built-in embedded runtime remains the guaranteed floor; anything here that fails degrades
// to that. Spawning is consent-gated + shell-free (mirror claude-cli), never with user input
// in the args, so it can't be a command-injection surface.

/** What to do when a local Ollama brain is needed. Pure → unit-tested. */
export type OllamaAction = "use-ollama" | "launch-then-use" | "use-builtin";

export function pickOllamaAction(installed: boolean, running: boolean, pref: OllamaLaunch): OllamaAction {
  if (running) return "use-ollama"; // already up → just use it
  if (pref === "always" && installed) return "launch-then-use"; // opted-in + present → start it
  return "use-builtin"; // ask/never, or not installed, or launch not wanted → the built-in floor
}

// Known absolute install locations by platform, checked in addition to PATH. Ollama's
// installers land here.
function knownOllamaPaths(): string[] {
  const home = app.getPath("home");
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"] ?? path.join(home, "AppData", "Local");
    return [path.join(local, "Programs", "Ollama", "ollama.exe"), "C:/Program Files/Ollama/ollama.exe"];
  }
  if (process.platform === "darwin") {
    return ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/Applications/Ollama.app/Contents/Resources/ollama"];
  }
  return ["/usr/local/bin/ollama", "/usr/bin/ollama", path.join(home, ".local", "bin", "ollama")];
}

/** Resolve the `ollama` executable path, or null. Scans PATH + known locations. Shell-free
 *  (no `which`/`where` subprocess) so it can't be a shell-injection surface. */
export function resolveOllamaBin(): string | null {
  const exe = process.platform === "win32" ? "ollama.exe" : "ollama";
  const dirs = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, exe);
    if (existsSync(p)) return p;
  }
  for (const p of knownOllamaPaths()) if (existsSync(p)) return p;
  return null;
}

/** Is Ollama installed on this computer? Unpackaged test seam DESKHAND_OLLAMA_INSTALLED
 *  ("1"/"0") pins the answer so the consent flow is CI-drivable without a real install. */
export function ollamaInstalled(): boolean {
  if (!app.isPackaged) {
    const seam = process.env["DESKHAND_OLLAMA_INSTALLED"];
    if (seam === "1") return true;
    if (seam === "0") return false;
  }
  return resolveOllamaBin() !== null;
}

let ollamaChild: ChildProcess | null = null;

// We record the pid of the `ollama serve` WE spawn to a small file, so if a hard kill (Task
// Manager / taskkill /F) skips our quit handlers and orphans it, the NEXT launch can reap it
// before it starves the GPU. Only ever OUR spawned pid — never an Ollama the user runs.
function pidFile(): string {
  return path.join(app.getPath("userData"), "ollama-managed.pid");
}
function recordOllamaPid(pid: number | undefined): void {
  if (!pid) return;
  try {
    writeFileSync(pidFile(), String(pid));
  } catch {
    /* best-effort */
  }
}
function clearOllamaPid(): void {
  try {
    rmSync(pidFile(), { force: true });
  } catch {
    /* best-effort */
  }
}

// Kill the WHOLE Ollama process tree — `ollama serve` spawns `ollama runner` children that
// hold the model in VRAM, and killing only the parent orphans them (the VRAM leak). On
// Windows `taskkill /T` reaps the descendant tree; elsewhere fall back to killing the process.
function killOllamaTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 5000 });
      return;
    } catch {
      /* fall through to a plain kill */
    }
  }
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
}

/** Kill any Ollama we started (app quit / signal). We never kill an Ollama the user was
 *  already running — only the child we spawned ourselves — and we reap its whole tree so no
 *  runner is left holding VRAM. */
export function disposeOllama(): void {
  const pid = ollamaChild?.pid;
  if (pid) {
    ollamaLog(`app exiting → killing our ollama tree (pid ${pid})`);
    killOllamaTree(pid);
  }
  ollamaChild = null;
  clearOllamaPid();
}

/** Startup reaper: if a previous session's exit didn't clean up (hard kill, or a dev Ctrl+C the
 *  harness swallowed), the `ollama serve` WE spawned is still holding VRAM. Identify it by the
 *  recorded pid, VERIFY the image is really ollama (so a reused pid can't hit an unrelated
 *  process), then kill its tree. Verbose so a dev can SEE it fire. Best-effort. */
export function sweepOrphanedOllama(): void {
  let raw: string;
  try {
    raw = readFileSync(pidFile(), "utf8").trim();
  } catch {
    ollamaLog("startup reaper: no pid file → nothing we spawned to reap");
    return;
  }
  const pid = parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    ollamaLog(`startup reaper: pid file has a bad value (${raw}) → clearing`);
    clearOllamaPid();
    return;
  }
  try {
    process.kill(pid, 0); // liveness probe — throws if the pid is gone
  } catch {
    ollamaLog(`startup reaper: our previous ollama (pid ${pid}) already exited → clearing`);
    clearOllamaPid();
    return;
  }
  // Verify identity before killing (guard against pid reuse hitting an unrelated process).
  if (process.platform === "win32") {
    try {
      const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8", timeout: 4000 });
      if (!/ollama/i.test(out.stdout ?? "")) {
        ollamaLog(`startup reaper: pid ${pid} is no longer ollama (reused) → clearing, not killing`);
        clearOllamaPid();
        return;
      }
    } catch {
      ollamaLog(`startup reaper: couldn't verify pid ${pid} via tasklist → leaving it alone`);
      return; // couldn't verify → don't risk killing the wrong process
    }
  }
  killOllamaTree(pid);
  ollamaLog(`startup reaper: REAPED orphaned ollama tree (pid ${pid}) from a previous session → VRAM freed`);
  clearOllamaPid();
}

// Spawn `ollama serve` shell-free. The fake seam records the attempt without a real process
// (the fake can't serve HTTP, so the caller's readiness poll will fall back to the built-in —
// the real launch-and-serve is hand-validation on a machine that actually has Ollama).
let fakeLaunchAttempts = 0;
export function fakeLaunchCount(): number {
  return fakeLaunchAttempts;
}

// Dev-only: surface OUR spawned Ollama's own log (it prints GPU discovery + whether it
// offloaded model layers to the GPU or fell back to CPU). Inert when packaged.
function ollamaLog(line: string): void {
  if (!app.isPackaged) console.log("[ollama]", line);
}

// Forward the spawned Ollama's STARTUP stderr in full (GPU discovery happens in the first
// seconds), then go quiet so per-request logs don't spam. A cap keeps it bounded. This is a
// debug seam for the CPU-vs-GPU investigation — Ollama prints exactly why it picked CPU here.
function pipeOllamaDiagnostics(child: ChildProcess): void {
  if (app.isPackaged || !child.stderr) return;
  child.stderr.setEncoding("utf8");
  let buf = "";
  let logged = 0;
  const MAX_LINES = 120; // enough for full startup + first model load
  child.stderr.on("data", (chunk: string) => {
    if (logged >= MAX_LINES) return;
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line && logged < MAX_LINES) {
        ollamaLog(line);
        if (++logged === MAX_LINES) ollamaLog("… (further Ollama logs suppressed)");
      }
    }
  });
}

// GPU selection is controlled by a handful of env vars; if one is set (e.g. by another tool
// on this machine, or inherited oddly by Electron), it silently forces CPU. Log them at spawn.
function logGpuEnv(): void {
  for (const k of ["CUDA_VISIBLE_DEVICES", "HIP_VISIBLE_DEVICES", "GGML_VK_VISIBLE_DEVICES", "OLLAMA_NUM_GPU", "OLLAMA_LLM_LIBRARY", "OLLAMA_HOST", "OLLAMA_MODELS"]) {
    const v = process.env[k];
    if (v !== undefined) ollamaLog(`env ${k}=${v}`);
  }
}

function startOllamaProcess(): boolean {
  if (!app.isPackaged && process.env["DESKHAND_OLLAMA_SPAWN_FAKE"] === "1") {
    fakeLaunchAttempts++;
    return true; // attempted (fake) — but it won't actually serve, so readiness will fail
  }
  // Already started one that's still alive? Don't spawn a second (two concurrent
  // local-Ollama-down calls, e.g. a chat send racing a brain test, would otherwise each
  // fork `ollama serve` and orphan the first — SECURE hardening note).
  if (ollamaChild && ollamaChild.exitCode === null && !ollamaChild.killed) return true;
  const bin = resolveOllamaBin();
  if (!bin) return false;
  try {
    // Shell-free, fixed args, no user input. Pipe stderr (dev only) so we can SEE whether our
    // spawned Ollama uses the GPU; not detached so it dies with us.
    ollamaChild = spawn(bin, ["serve"], {
      // Keep ONE model in VRAM at a time: switching models evicts the previous one instead of
      // stacking them. An average user testing a few models would otherwise fill VRAM and each
      // new model would spill to CPU (the slowdown we just chased). Only applies to the Ollama
      // WE launch; a user running their own Ollama keeps their own config.
      env: { ...process.env, OLLAMA_MAX_LOADED_MODELS: "1" },
      stdio: ["ignore", "ignore", app.isPackaged ? "ignore" : "pipe"],
    });
    ollamaChild.on("error", () => {}); // a failed spawn must never crash main
    recordOllamaPid(ollamaChild.pid); // so a hard-kill orphan is reaped next launch
    pipeOllamaDiagnostics(ollamaChild);
    ollamaLog(`spawned \`ollama serve\` from ${bin}`);
    logGpuEnv();
    return true;
  } catch {
    return false;
  }
}

/** Start Ollama (consent already checked by the caller) and wait until it answers, or give
 *  up. Returns whether it's reachable afterward. `detect` is the loopback readiness ping
 *  (injected so this is testable). The fake seam short-circuits the wait (it won't serve). */
export async function ensureOllamaRunning(detect: () => Promise<boolean>, timeoutMs = 8000): Promise<boolean> {
  const started = startOllamaProcess();
  if (!started) return false;
  if (!app.isPackaged && process.env["DESKHAND_OLLAMA_SPAWN_FAKE"] === "1") return false; // fake doesn't serve
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await detect()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
