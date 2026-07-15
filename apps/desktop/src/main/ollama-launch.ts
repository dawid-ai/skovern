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

function startOllamaProcess(): boolean {
  if (!app.isPackaged && process.env["DESKHAND_OLLAMA_SPAWN_FAKE"] === "1") {
    fakeLaunchAttempts++;
    return true; // attempted (fake) — but it won't actually serve, so readiness will fail
  }
  const bin = resolveOllamaBin();
  if (!bin) return false;
  try {
    // Shell-free, fixed args, no user input. stdio ignored; not detached so it dies with us.
    ollamaChild = spawn(bin, ["serve"], { stdio: "ignore" });
    ollamaChild.on("error", () => {}); // a failed spawn must never crash main
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
