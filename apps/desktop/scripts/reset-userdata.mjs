// Dev-only reset: wipe Skovern's local state so the NEXT launch is a clean first-run
// (fresh sign-in + onboarding). Leaves Electron's own caches alone. Never runs in a packaged
// app — it's a dev script you invoke by hand.
//
//   pnpm --filter @skovern/desktop reset             # full fresh — also removes downloaded models
//   pnpm --filter @skovern/desktop reset -- --keep-models   # keep the GGUFs (skip the re-download)
//
// After a reset, run `pnpm --filter @skovern/desktop dev` and you're onboarding from scratch.

import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const keepModels = process.argv.includes("--keep-models");

// Where Electron puts userData for app name "Skovern", per-OS (matches app.setName("Skovern")).
function userDataDir() {
  const home = os.homedir();
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Skovern");
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Skovern");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Skovern");
}

const dir = userDataDir();
if (!existsSync(dir)) {
  console.log(`[reset] no Skovern data at ${dir} — already fresh.`);
  process.exit(0);
}

// The app's own state (NOT Electron's Cache/GPUCache/etc., which are safe to keep and regenerate).
const fixed = ["brain.bin", "session.bin", "chats", ...(keepModels ? [] : ["models"])];
const receiptFiles = readdirSync(dir).filter((f) => f.startsWith("receipts"));
const targets = [...fixed, ...receiptFiles];

let removed = 0;
for (const t of targets) {
  const p = path.join(dir, t);
  if (existsSync(p)) {
    rmSync(p, { recursive: true, force: true });
    console.log(`[reset] removed ${t}`);
    removed++;
  }
}
console.log(`[reset] done — ${removed} item(s) cleared${keepModels ? " (kept models)" : ""}. Next launch is a fresh first-run.`);
