import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
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

/** Kill any Ollama we started (called on app quit). We never kill an Ollama the user was
 *  already running — only a child we spawned ourselves. */
export function disposeOllama(): void {
  try {
    ollamaChild?.kill();
  } catch {
    /* already gone */
  }
  ollamaChild = null;
}

// Spawn `ollama serve` shell-free. The fake seam records the attempt without a real process
// (the fake can't serve HTTP, so the caller's readiness poll will fall back to the built-in —
// the real launch-and-serve is hand-validation on a machine that actually has Ollama).
let fakeLaunchAttempts = 0;
export function fakeLaunchCount(): number {
  return fakeLaunchAttempts;
}

// Dev-only: surface the GPU-relevant lines from OUR spawned Ollama's own log (it prints
// whether it offloaded model layers to the GPU or fell back to CPU). Inert when packaged.
function ollamaLog(line: string): void {
  if (!app.isPackaged) console.log("[ollama]", line);
}

// Forward the spawned Ollama's stderr, keeping only the lines that reveal GPU vs CPU / model
// load (Ollama's stderr is very chatty; this is a debug seam for the CPU-vs-GPU investigation).
function pipeOllamaDiagnostics(child: ChildProcess): void {
  if (app.isPackaged || !child.stderr) return;
  child.stderr.setEncoding("utf8");
  let buf = "";
  const KEEP = /gpu|vram|cuda|rocm|metal|offload|layers|library=|no compatible|inference compute|compute capab|memory available|total memory/i;
  child.stderr.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line && KEEP.test(line)) ollamaLog(line);
    }
  });
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
    ollamaChild = spawn(bin, ["serve"], { stdio: ["ignore", "ignore", app.isPackaged ? "ignore" : "pipe"] });
    ollamaChild.on("error", () => {}); // a failed spawn must never crash main
    pipeOllamaDiagnostics(ollamaChild);
    ollamaLog(`spawned \`ollama serve\` from ${bin}`);
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
