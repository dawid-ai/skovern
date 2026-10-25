import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppUpdater, ProgressInfo } from "electron-updater";
import { RefusedUpdate, type FoundUpdate, type UpdaterPort } from "./updates.js";

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

// The rest of a path after a known folder or a drive letter: up to a space, quote, bracket, or
// comma, never ending on a full stop.
const TAIL = String.raw`(?:[^\s"'<>(),]*[^\s"'<>(),.])?`;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Absolute file paths become <path>. Known folders (home, AppData, Program Files, the app's
 *  own) go first, because their names can hold spaces ("C:\Users\Dawid Jozwiak"); then any
 *  drive, UNC, or home path. A drive letter stands alone, so `https://` isn't one. */
export function redactPaths(line: string, roots: string[] = []): string {
  let out = line;
  for (const root of [...roots].filter((r) => r.length > 3).sort((a, b) => b.length - a.length)) {
    const either = escapeRe(root).replace(/\\\\|\//g, String.raw`[\\/]`);
    out = out.replace(new RegExp(either + TAIL, "gi"), "<path>");
  }
  return out
    .replace(new RegExp(String.raw`(?<![\w])[A-Za-z]:(?:\\|\/(?!\/))` + TAIL, "g"), "<path>")
    .replace(new RegExp(String.raw`\\\\[^\\\s]+\\` + TAIL, "g"), "<path>")
    .replace(new RegExp(String.raw`\/(?:Users|home)\/` + TAIL, "g"), "<path>");
}

/** The folders whose names a log line may carry, with spaces and all. */
function knownRoots(userData: string): string[] {
  const env = process.env;
  return [userData, os.homedir(), path.dirname(process.execPath), env["LOCALAPPDATA"], env["APPDATA"], env["ProgramFiles"], env["ProgramFiles(x86)"]].filter(
    (r): r is string => typeof r === "string",
  );
}

/** Appends to userData/logs/updates.log; past 256 KB the old file moves to updates.log.1.
 *  Messages only (the feed is public and needs no token), with file paths replaced by
 *  <path> so the log never records where things live on this computer. */
export function updatesLog(userData: string): (line: string) => void {
  const dir = path.join(userData, "logs");
  const file = path.join(dir, "updates.log");
  const roots = knownRoots(userData);
  return (line) => {
    try {
      mkdirSync(dir, { recursive: true });
      try {
        if (statSync(file).size > LOG_CAP) renameSync(file, `${file}.1`);
      } catch {
        // no log yet
      }
      appendFileSync(file, `${new Date().toISOString()} ${redactPaths(line, roots).replace(/\s+/g, " ")}\n`);
    } catch {
      // a log must never break the app
    }
  };
}

/** electron-updater sends a random install ID (kept in userData/.updaterId) on every check, for
 *  staged rollouts we don't use. Sending zeros instead keeps checks from different places from
 *  being tied to one computer; electron-updater applies our headers last. */
export const NO_INSTALL_ID = { "x-user-staging-id": "00000000-0000-0000-0000-000000000000" };

interface ReleaseInfo {
  version: string;
  tag?: unknown;
  files?: { isAdminRightsRequired?: boolean }[];
}

/** Why an offered update is refused, or null. electron-updater takes whatever GitHub marks
 *  "latest", whatever its tag. Our release workflow only publishes tag v<version>, and Skovern
 *  installs per user, so anything else (another tag, a request for admin rights) didn't come
 *  from it. */
export function refuseReason(info: ReleaseInfo): string | null {
  if (info.tag !== `v${info.version}`) return `release tag ${String(info.tag)} isn't v${info.version}`;
  if ((info.files ?? []).some((f) => f.isAdminRightsRequired === true)) return "release asks for admin rights";
  return null;
}

/** electron-updater, configured for "ask first": nothing downloads until the user says so. */
export function electronPort(updater: AppUpdater, log: (line: string) => void): UpdaterPort {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true; // a downloaded update installs when Skovern quits
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  updater.requestHeaders = { ...NO_INSTALL_ID };
  // Warnings and errors only: electron-updater's info lines narrate every step, with paths.
  updater.logger = { info: () => {}, warn: (m) => log(`warn ${String(m)}`), error: (m) => log(`error ${String(m)}`), debug: () => {} };
  // electron-updater remembers the release from its LAST check and downloads that one, whatever
  // we decided about it. So a download needs the last check to have been accepted here.
  let accepted: string | null = null;
  return {
    async check(): Promise<FoundUpdate | null> {
      const r = await updater.checkForUpdates();
      // Cleared only once the feed answered: an offline check changes nothing electron-updater
      // holds, so the earlier accepted offer stays downloadable.
      accepted = null;
      if (!r || !r.isUpdateAvailable) return null;
      const refused = refuseReason(r.updateInfo as ReleaseInfo);
      if (refused) throw new RefusedUpdate(`update refused: ${refused}`);
      accepted = r.updateInfo.version;
      return { version: r.updateInfo.version, notes: notesToText(r.updateInfo.releaseNotes) };
    },
    async download(onProgress): Promise<number> {
      if (accepted === null) throw new RefusedUpdate("no accepted update to download");
      // Bytes that actually arrived (a differential download fetches less than the file).
      let received = 0;
      const tick = (p: ProgressInfo): void => {
        received = Math.max(received, p.transferred);
        onProgress(p.percent);
      };
      updater.on("download-progress", tick);
      try {
        await updater.downloadUpdate();
      } finally {
        updater.off("download-progress", tick);
      }
      return received;
    },
    install(onFailed): void {
      // A failed start is reported only as an error event, emitted before quitAndInstall
      // returns; the listener goes right after, so a later unrelated error isn't taken for it.
      updater.once("error", onFailed);
      try {
        updater.quitAndInstall(true, true); // silent install, then relaunch
      } finally {
        updater.off("error", onFailed);
      }
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
