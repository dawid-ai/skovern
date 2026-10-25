import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AppUpdater } from "electron-updater";
import { FAKE_VERSION, electronPort, fakePort, fakeScenario, notesToText, redactPaths, refuseReason, updatesLog } from "./updates-port.js";

describe("release notes as plain text", () => {
  it("drops tags, keeps lines and bullets, decodes entities", () => {
    const html = "<h2>What&#39;s new</h2><ul><li>Faster &amp; quieter</li><li>A <a href=\"https://x.test\">link</a></li></ul><script>alert(1)</script>";
    expect(notesToText(html)).toBe("What's new\n• Faster & quieter\n• A link\nalert(1)");
  });

  it("takes the notes array form and caps the length", () => {
    expect(notesToText([{ note: "One" }, { note: null }, { note: "Two" }])).toBe("One\n\nTwo");
    expect(notesToText("x".repeat(5000))).toHaveLength(2000);
    expect(notesToText(null)).toBe("");
  });
});

// SECURE iteration 1: the install ID, and releases the release workflow didn't publish.
describe("real feed (electron-updater) settings", () => {
  type Listener = (...a: unknown[]) => void;
  function fakeUpdater(updateInfo: Record<string, unknown>) {
    const listeners = new Map<string, Listener>();
    const u = {
      requestHeaders: null as Record<string, string> | null,
      checkForUpdates: async () => ({ isUpdateAvailable: true, updateInfo }),
      downloadUpdate: async () => {
        listeners.get("download-progress")?.({ total: 1000, transferred: 300, percent: 30 });
        listeners.get("download-progress")?.({ total: 1000, transferred: 420, percent: 100 });
        return [];
      },
      on: (e: string, f: Listener) => listeners.set(e, f),
      off: (e: string) => listeners.delete(e),
      once: (e: string, f: Listener) => listeners.set(e, f),
      quitAndInstall: () => {},
    };
    return u;
  }
  const good = { version: "0.1.1", tag: "v0.1.1", releaseNotes: "<p>Faster.</p>", files: [{ url: "Skovern-Setup.exe" }] };

  it("sends zeros instead of the per-install ID", () => {
    const u = fakeUpdater(good);
    electronPort(u as unknown as AppUpdater, () => {});
    expect(u.requestHeaders).toEqual({ "x-user-staging-id": "00000000-0000-0000-0000-000000000000" });
  });

  it("offers a release tagged v<version>", async () => {
    await expect(electronPort(fakeUpdater(good) as unknown as AppUpdater, () => {}).check()).resolves.toEqual({ version: "0.1.1", notes: "Faster." });
  });

  it("refuses a release on another tag, or one asking for admin rights", async () => {
    await expect(electronPort(fakeUpdater({ ...good, tag: "build-7" }) as unknown as AppUpdater, () => {}).check()).rejects.toThrow("update refused: release tag build-7 isn't v0.1.1");
    const admin = { ...good, files: [{ url: "Skovern-Setup.exe", isAdminRightsRequired: true }] };
    await expect(electronPort(fakeUpdater(admin) as unknown as AppUpdater, () => {}).check()).rejects.toThrow("update refused: release asks for admin rights");
    expect(refuseReason({ version: "0.1.1" })).toBe("release tag undefined isn't v0.1.1");
  });

  // SECURE iteration 2: electron-updater downloads whatever its LAST check found.
  it("after a refused check, an earlier accepted offer can't be downloaded", async () => {
    const u = fakeUpdater(good);
    let downloads = 0;
    const realDownload = u.downloadUpdate;
    u.downloadUpdate = async () => {
      downloads += 1;
      return realDownload();
    };
    const port = electronPort(u as unknown as AppUpdater, () => {});
    await port.check(); // v0.1.1 accepted
    const evil = { ...good, version: "0.1.2", tag: "build-7" };
    u.checkForUpdates = async () => ({ isUpdateAvailable: true, updateInfo: evil });
    await expect(port.check()).rejects.toThrow("update refused: release tag build-7 isn't v0.1.2");
    await expect(port.download(() => {})).rejects.toThrow("no accepted update to download");
    expect(downloads).toBe(0);
  });

  it("counts the bytes that arrived, not the file size", async () => {
    const port = electronPort(fakeUpdater(good) as unknown as AppUpdater, () => {});
    await port.check();
    expect(await port.download(() => {})).toBe(420);
  });
});

describe("SKOVERN_UPDATER_FAKE seam", () => {
  it("is honoured only in an unpackaged build, and only for known scenarios", () => {
    expect(fakeScenario(false, { SKOVERN_UPDATER_FAKE: "available" })).toBe("available");
    expect(fakeScenario(true, { SKOVERN_UPDATER_FAKE: "available" })).toBeNull();
    expect(fakeScenario(false, { SKOVERN_UPDATER_FAKE: "anything" })).toBeNull();
    expect(fakeScenario(false, {})).toBeNull();
  });

  it("the fake feed finds an update, downloads with progress, and counts installs", async () => {
    const installs = { count: 0 };
    const port = fakePort("available", installs);
    expect((await port.check())?.version).toBe(FAKE_VERSION);
    const seen: number[] = [];
    expect(await port.download((p) => seen.push(p))).toBe(1024);
    expect(seen.at(-1)).toBe(100);
    port.install(() => {});
    expect(installs.count).toBe(1);
    await expect(fakePort("error", installs).check()).rejects.toThrow("fake feed: unreachable");
  });
});

describe("update log", () => {
  it("never records file paths", () => {
    const bs = String.fromCharCode(92);
    const win = "C:" + bs + "Users" + bs + "jozwi" + bs + "AppData" + bs + "Local" + bs + "@skoverndesktop-updater" + bs + "pending" + bs + "Skovern-Setup.exe";
    expect(redactPaths("Update has already been downloaded to " + win + ").")).toBe("Update has already been downloaded to <path>).");
    expect(redactPaths("open /Users/dawid/Library/x failed")).toBe("open <path> failed");
    expect(redactPaths("https://github.com/dawid-ai/skovern/releases.atom 404")).toBe("https://github.com/dawid-ai/skovern/releases.atom 404");
  });

  // Checker iteration 2: folder names with spaces leaked past the first space.
  it("hides known folders whose names have spaces, and UNC paths", () => {
    const bs = String.fromCharCode(92);
    const j = (...p: string[]): string => p.join(bs);
    const home = j("C:", "Users", "Dawid Jozwiak");
    const pf = j("C:", "Program Files");
    const roots = [home, pf, j(home, "AppData", "Local")];
    expect(redactPaths("downloaded to " + j(home, "AppData", "Local", "x-updater", "pending", "Skovern-Setup.exe") + ".", roots)).toBe("downloaded to <path>.");
    expect(redactPaths("open " + j(pf, "Skovern", "resources", "app.asar") + " failed", roots)).toBe("open <path> failed");
    expect(redactPaths("forward slashes C:/Users/Dawid Jozwiak/x.txt too", roots)).toBe("forward slashes <path> too");
    expect(redactPaths("share " + bs + bs + j("server", "share", "Skovern-Setup.exe") + " gone")).toBe("share <path> gone");
  });

  it("writes one line per entry under userData/logs and rolls over past 256 KB", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "skovern-updlog-"));
    try {
      const log = updatesLog(dir);
      log("check failed:\n offline");
      const file = path.join(dir, "logs", "updates.log");
      expect(readFileSync(file, "utf8")).toMatch(/^\S+ check failed: offline\n$/);
      writeFileSync(file, "x".repeat(300 * 1024));
      log("next");
      expect(existsSync(`${file}.1`)).toBe(true);
      expect(statSync(file).size).toBeLessThan(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws when the folder can't be written", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "skovern-updlog-"));
    try {
      writeFileSync(path.join(dir, "logs"), "a file where the folder should be");
      expect(() => updatesLog(dir)("x")).not.toThrow();
      mkdirSync(path.join(dir, "ok"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
