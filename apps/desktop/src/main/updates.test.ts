import { describe, expect, it } from "vitest";
import type { FetchReceipt } from "@skovern/core";
import type { UpdatesView } from "../shared/updates.js";
import { CHECK_EVERY_MS, CHECK_TASK, DOWNLOAD_TASK, RefusedUpdate, createUpdates, type FoundUpdate, type UpdaterPort } from "./updates.js";

// release-updates M3/M4: the update flow's states, and the egress rule — every check and
// download has its receipt on disk BEFORE the request leaves, or the request never happens.

interface Rig {
  events: string[]; // ordered: receipt phases and port calls, as they happen
  receipts: FetchReceipt[];
  views: UpdatesView[];
  auto: { on: boolean };
  installs: number;
}

function rig(opts: { found?: FoundUpdate | null; checkFails?: boolean; downloadFails?: boolean; sinkFails?: boolean; port?: boolean; installFails?: boolean; refuseAfter?: number } = {}) {
  let checks = 0;
  const r: Rig = { events: [], receipts: [], views: [], auto: { on: true }, installs: 0 };
  let release: () => void = () => {};
  const port: UpdaterPort = {
    async check() {
      r.events.push("port:check");
      checks += 1;
      if (opts.checkFails) throw new Error("offline");
      if (opts.refuseAfter !== undefined && checks > opts.refuseAfter) throw new RefusedUpdate("update refused: release tag build-7 isn't v0.2.0");
      return opts.found === undefined ? { version: "0.2.0", notes: "Faster." } : opts.found;
    },
    async download(onProgress) {
      r.events.push("port:download");
      onProgress(40.4);
      await new Promise<void>((res) => (release = res));
      if (opts.downloadFails) throw new Error("cut off");
      onProgress(100);
      return 2048;
    },
    install(onFailed) {
      r.installs += 1;
      if (opts.installFails) onFailed(new Error("installer gone"));
    },
  };
  const u = createUpdates({
    port: opts.port === false ? null : port,
    sink: {
      append(receipt) {
        if (opts.sinkFails) throw new Error("disk full");
        r.events.push(`receipt:${receipt.task}:${receipt.phase}`);
        r.receipts.push(receipt);
      },
    },
    current: "0.1.0",
    getAuto: () => r.auto.on,
    saveAuto: (on) => (r.auto.on = on),
    emit: (v) => r.views.push(v),
    log: () => {},
    now: () => new Date("2026-10-25T10:00:00.000Z"),
  });
  return { r, u, finishDownload: () => release() };
}

describe("update checks", () => {
  it("M4: the check receipt is written before the request leaves, and is a quiet routine line", async () => {
    const { r, u } = rig();
    await u.check(true);
    expect(r.events).toEqual([`receipt:${CHECK_TASK}:sent`, "port:check", `receipt:${CHECK_TASK}:done`]);
    expect(r.receipts[0]).toMatchObject({ kind: "fetch", host: "github.com", routine: true, direction: "in", bytesSent: 0 });
    expect(u.view().state).toEqual({ kind: "available", version: "0.2.0", notes: "Faster." });
  });

  it("M4: no receipt, no request — a check whose receipt can't be written never reaches the feed", async () => {
    const { r, u } = rig({ sinkFails: true });
    await u.check(true);
    expect(r.events).not.toContain("port:check");
    expect(u.view().state).toEqual({ kind: "error", during: "check" });
  });

  it("up to date → none", async () => {
    const { u } = rig({ found: null });
    expect((await u.check(true)).state).toEqual({ kind: "none" });
  });

  it("M3: a failed check the user started says so; a failed background check stays quiet", async () => {
    const user = rig({ checkFails: true });
    expect((await user.u.check(true)).state).toEqual({ kind: "error", during: "check" });
    const bg = rig({ checkFails: true });
    expect((await bg.u.check(false)).state).toEqual({ kind: "idle" });
    expect(bg.r.views.map((v) => v.state.kind)).toEqual(["checking", "idle"]);
    // still receipted: the request was attempted, and failed
    expect(bg.r.receipts.map((x) => [x.phase, x.ok])).toEqual([["sent", true], ["done", false]]);
  });

  it("M3: a dev build with no feed can't check and never writes a receipt", async () => {
    const { r, u } = rig({ port: false });
    expect(u.view().canUpdate).toBe(false);
    await u.check(true);
    expect(r.events).toEqual([]);
  });
});

describe("downloads", () => {
  it("nothing downloads until asked; then the receipt lands first, progress shows, and it ends ready", async () => {
    const { r, u, finishDownload } = rig();
    await u.check(false);
    expect(r.events).not.toContain("port:download");
    const pending = u.download();
    await Promise.resolve();
    expect(r.events.slice(-2)).toEqual([`receipt:${DOWNLOAD_TASK}:sent`, "port:download"]);
    expect(u.view().state).toEqual({ kind: "downloading", version: "0.2.0", percent: 40 });
    finishDownload();
    expect((await pending).state).toEqual({ kind: "ready", version: "0.2.0", notes: "Faster." });
    const done = r.receipts.find((x) => x.task === DOWNLOAD_TASK && x.phase === "done");
    expect(done).toMatchObject({ ok: true, bytesReceived: 2048 });
    expect(done?.routine).toBeUndefined(); // a download you asked for is its own line, not routine
  });

  it("M3: a failed download offers Try again, which downloads again", async () => {
    const { u, finishDownload } = rig({ downloadFails: true });
    await u.check(true);
    const first = u.download();
    await Promise.resolve();
    finishDownload();
    expect((await first).state).toEqual({ kind: "error", during: "download", version: "0.2.0" });
    const again = u.download();
    await Promise.resolve();
    expect(u.view().state.kind).toBe("downloading");
    finishDownload();
    await again;
  });

  it("a download can't start without a found update, and checks don't run over a download", async () => {
    const { r, u, finishDownload } = rig();
    await u.download();
    expect(r.events).toEqual([]);
    await u.check(true);
    const pending = u.download();
    await Promise.resolve();
    await u.check(true);
    expect(r.events.filter((e) => e === "port:check")).toHaveLength(1);
    finishDownload();
    await pending;
  });

  it("install only from ready", async () => {
    const { r, u, finishDownload } = rig();
    u.install();
    expect(r.installs).toBe(0);
    await u.check(true);
    const pending = u.download();
    await Promise.resolve();
    finishDownload();
    await pending;
    u.install();
    expect(r.installs).toBe(1);
  });
});

describe("refused releases", () => {
  // SECURE iteration 2: a refused background check must not leave an older offer clickable.
  it("a refused background check drops the earlier offer; Update now does nothing", async () => {
    const { r, u } = rig({ refuseAfter: 1 });
    expect((await u.check(false)).state.kind).toBe("available");
    expect((await u.check(false)).state).toEqual({ kind: "idle" });
    await u.download();
    expect(r.events).not.toContain("port:download");
  });

  it("a refused check you started says it couldn't check, with nothing to download", async () => {
    const { r, u } = rig({ refuseAfter: 0 });
    expect((await u.check(true)).state).toEqual({ kind: "error", during: "check" });
    await u.download();
    expect(r.events).not.toContain("port:download");
  });
});

describe("install", () => {
  it("a failed install goes back to didn't finish with Try again, never a dead Restart now", async () => {
    const { r, u, finishDownload } = rig({ installFails: true });
    await u.check(true);
    let pending = u.download();
    await Promise.resolve();
    finishDownload();
    await pending;
    expect(u.install().state).toEqual({ kind: "error", during: "download", version: "0.2.0" });
    expect(r.installs).toBe(1);
    pending = u.download(); // Try again downloads afresh
    await Promise.resolve();
    expect(u.view().state.kind).toBe("downloading");
    finishDownload();
    expect((await pending).state.kind).toBe("ready");
  });
});

describe("schedule", () => {
  function fakeTimer() {
    const t = { ms: 0, fn: (() => {}) as () => void, stopped: false };
    return { t, timer: { every: (ms: number, fn: () => void) => ((t.ms = ms), (t.fn = fn), () => (t.stopped = true)) } };
  }

  it("checks at launch and every 6 hours while automatic checks are on", async () => {
    const { r, u } = rig({ found: null });
    const { t, timer } = fakeTimer();
    const stop = u.startSchedule(timer);
    await Promise.resolve();
    expect(t.ms).toBe(CHECK_EVERY_MS);
    expect(CHECK_EVERY_MS).toBe(6 * 60 * 60 * 1000);
    expect(r.events.filter((e) => e === "port:check")).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 0));
    t.fn();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.events.filter((e) => e === "port:check")).toHaveLength(2);
    stop();
    expect(t.stopped).toBe(true);
  });

  it("M4: with automatic checks off, launch makes no check and writes no receipt", async () => {
    const { r, u } = rig();
    u.setAuto(false);
    const { t, timer } = fakeTimer();
    u.startSchedule(timer);
    t.fn();
    await new Promise((res) => setTimeout(res, 0));
    expect(r.events).toEqual([]);
    expect(r.receipts).toEqual([]);
    expect(u.view().auto).toBe(false);
  });
});
