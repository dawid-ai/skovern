import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import type { AppUpdater, ProgressInfo } from "electron-updater";
import type { FoundUpdate, UpdaterPort } from "./updates.js";

// The real feed (electron-updater → GitHub Releases), a fake feed for tests, the update log,
// and release notes as plain text.

type ReleaseNotes = string | { note?: string | null }[] | null | undefined;

const MAX_NOTES = 2000;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** GitHub serves release notes as HTML. The app shows them as plain text only: tags dropped,
 *  common entities decoded, blank runs collapsed, length capped. */
export function notesToText(notes: ReleaseNotes): string {
  const raw = Array.isArray(notes) ? notes.map((n) => n.note ?? "").join("\n") : (notes ?? "");
  const text = raw
    .replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, all) => l.length > 0 || (i > 0 && all[i - 1]!.length > 0))
    .join("\n")
    .trim();
  return text.length > MAX_NOTES ? `${text.slice(0, MAX_NOTES - 1)}…` : text;
}

const LOG_CAP = 256 * 1024;

/** Absolute file paths (Windows drive paths, user home folders) become <path>. */
export function redactPaths(line: string): string {
  // A path ends before a space, quote, bracket, or comma, and never on a trailing full stop.
  // A drive letter stands alone (so `https://` isn't one).
  return line.replace(/(?<![\w])[A-Za-z]:(?:\\|\/(?!\/))(?:[^\s"'<>(),]*[^\s"'<>(),.])?/g, "<path>").replace(/\/(?:Users|home)\/(?:[^\s"'<>(),]*[^\s"'<>(),.])?/g, "<path>");
}

/** Appends to userData/logs/updates.log; past 256 KB the old file moves to updates.log.1.
 *  Messages only (the feed is public and needs no token), with file paths replaced by
 *  <path> so the log never records where things live on this computer. */
export function updatesLog(userData: string): (line: string) => void {
  const dir = path.join(userData, "logs");
  const file = path.join(dir, "updates.log");
  return (line) => {
    try {
      mkdirSync(dir, { recursive: true });
      try {
        if (statSync(file).size > LOG_CAP) renameSync(file, `${file}.1`);
      } catch {
        // no log yet
      }
      appendFileSync(file, `${new Date().toISOString()} ${redactPaths(line).replace(/\s+/g, " ")}\n`);
    } catch {
      // a log must never break the app
    }
  };
}

/** electron-updater, configured for "ask first": nothing downloads until the user says so. */
export function electronPort(updater: AppUpdater, log: (line: string) => void): UpdaterPort {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true; // a downloaded update installs when Skovern quits
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  // Warnings and errors only: electron-updater's info lines narrate every step, with paths.
  updater.logger = { info: () => {}, warn: (m) => log(`warn ${String(m)}`), error: (m) => log(`error ${String(m)}`), debug: () => {} };
  return {
    async check(): Promise<FoundUpdate | null> {
      const r = await updater.checkForUpdates();
      if (!r || !r.isUpdateAvailable) return null;
      return { version: r.updateInfo.version, notes: notesToText(r.updateInfo.releaseNotes) };
    },
    async download(onProgress): Promise<number> {
      let total = 0;
      const tick = (p: ProgressInfo): void => {
        total = p.total;
        onProgress(p.percent);
      };
      updater.on("download-progress", tick);
      try {
        await updater.downloadUpdate();
      } finally {
        updater.off("download-progress", tick);
      }
      return total;
    },
    install(onFailed): void {
      updater.once("error", onFailed); // a failed start is reported only as an error event
      updater.quitAndInstall(true, true); // silent install, then relaunch
    },
  };
}

export type FakeScenario = "none" | "available" | "error" | "slow" | "download-error";
const SCENARIOS: readonly FakeScenario[] = ["none", "available", "error", "slow", "download-error"];

export const FAKE_VERSION = "0.99.0";
export const FAKE_NOTES = "Your brain answers faster.\nA new Receipts filter.";

/** The `SKOVERN_UPDATER_FAKE` scenario, honoured ONLY in an unpackaged build (same rule as
 *  every other SKOVERN_* seam); a packaged app always uses the real feed. */
export function fakeScenario(isPackaged: boolean, env: NodeJS.ProcessEnv): FakeScenario | null {
  if (isPackaged) return null;
  const v = env["SKOVERN_UPDATER_FAKE"];
  return SCENARIOS.find((s) => s === v) ?? null;
}

/** A test feed. `installs` counts install calls so an e2e can prove "Restart now" fired. */
export function fakePort(scenario: FakeScenario, installs: { count: number }): UpdaterPort {
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  return {
    async check() {
      if (scenario === "slow") await wait(1500);
      if (scenario === "error") throw new Error("fake feed: unreachable");
      return scenario === "available" || scenario === "download-error" ? { version: FAKE_VERSION, notes: FAKE_NOTES } : null;
    },
    async download(onProgress) {
      for (const p of [10, 45, 80]) {
        await wait(400); // slow enough for an e2e to click Later mid-download
        onProgress(p);
      }
      if (scenario === "download-error") throw new Error("fake feed: download cut off");
      onProgress(100);
      return 1024;
    },
    install() {
      installs.count += 1;
    },
  };
}
