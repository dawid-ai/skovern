import type { FetchSink } from "@skovern/core";
import type { UpdateState, UpdatesView } from "../shared/updates.js";

// The update flow, behind a small port so tests drive a fake feed (release-updates loop).
// The user is asked before anything downloads. Every check and download is egress, so its
// receipt is written BEFORE the request leaves; if the receipt can't be written, the request
// never happens (fail closed, same rule as every other outbound call).

export interface FoundUpdate {
  version: string;
  /** Release notes as plain text (never HTML). */
  notes: string;
}

export interface UpdaterPort {
  /** The newer release, or null when this is the latest. */
  check(): Promise<FoundUpdate | null>;
  /** Downloads the found update; resolves with the bytes received. */
  download(onProgress: (percent: number) => void): Promise<number>;
  /** Quits, installs silently, and relaunches. Calls onFailed if the install can't start
   *  (for example the downloaded installer is gone). */
  install(onFailed: (e: unknown) => void): void;
}

/** Skovern sits in the tray for days, so it also checks while running, not just at launch. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// Every request electron-updater makes goes to github.com (downloads then redirect to
// GitHub's asset host). Host only, never a full URL.
const FEED_HOST = "github.com";
export const CHECK_TASK = "Skovern: update check";
export const DOWNLOAD_TASK = "Skovern: update download";

export interface UpdatesOptions {
  /** Null in a dev build with no test feed: nothing to update from. */
  port: UpdaterPort | null;
  sink: FetchSink;
  current: string;
  getAuto(): boolean;
  saveAuto(on: boolean): void;
  emit(view: UpdatesView): void;
  log(line: string): void;
  now?: () => Date;
}

export interface Updates {
  view(): UpdatesView;
  check(userStarted: boolean): Promise<UpdatesView>;
  download(): Promise<UpdatesView>;
  install(): UpdatesView;
  setAuto(on: boolean): UpdatesView;
  /** Checks now (if automatic checks are on) and every CHECK_EVERY_MS. Returns a stop. */
  startSchedule(timer?: { every(ms: number, fn: () => void): () => void }): () => void;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 500);

export function createUpdates(o: UpdatesOptions): Updates {
  let state: UpdateState = { kind: "idle" };
  let found: FoundUpdate | null = null;

  const view = (): UpdatesView => ({ current: o.current, canUpdate: o.port !== null, auto: o.getAuto(), state });
  const set = (next: UpdateState): void => {
    state = next;
    o.emit(view());
  };
  const receipt = (task: string, phase: "sent" | "done", ok: boolean, bytesReceived: number): Promise<void> =>
    Promise.resolve(
      o.sink.append({
        kind: "fetch",
        ts: (o.now?.() ?? new Date()).toISOString(),
        host: FEED_HOST,
        task,
        bytesSent: 0,
        bytesReceived,
        ok,
        phase,
        direction: "in",
        // The background check is a routine poll; a download the user asked for is not.
        ...(task === CHECK_TASK ? { routine: true } : {}),
      }),
    );
  const done = (task: string, ok: boolean, bytes: number): void => {
    receipt(task, "done", ok, bytes).catch((e: unknown) => o.log(`receipt failed: ${errText(e)}`));
  };

  async function check(userStarted: boolean): Promise<UpdatesView> {
    const port = o.port;
    // One thing at a time: never re-check over a check, a download, or a ready update.
    if (!port || state.kind === "checking" || state.kind === "downloading" || state.kind === "ready") return view();
    const before = state;
    // A failed background check stays quiet: the screen goes back to what it showed.
    const failed = (): UpdateState => (userStarted ? { kind: "error", during: "check" } : before);
    set({ kind: "checking", userStarted });
    try {
      await receipt(CHECK_TASK, "sent", true, 0);
    } catch (e) {
      o.log(`check skipped, receipt failed: ${errText(e)}`);
      set(failed());
      return view();
    }
    try {
      found = await port.check();
      done(CHECK_TASK, true, 0);
      set(found ? { kind: "available", ...found } : { kind: "none" });
    } catch (e) {
      o.log(`check failed: ${errText(e)}`);
      done(CHECK_TASK, false, 0);
      set(failed());
    }
    return view();
  }

  async function download(): Promise<UpdatesView> {
    const port = o.port;
    const retry = state.kind === "error" && state.during === "download";
    if (!port || !found || (state.kind !== "available" && !retry)) return view();
    const { version, notes } = found;
    set({ kind: "downloading", version, percent: 0 });
    try {
      await receipt(DOWNLOAD_TASK, "sent", true, 0);
    } catch (e) {
      o.log(`download skipped, receipt failed: ${errText(e)}`);
      set({ kind: "error", during: "download", version });
      return view();
    }
    try {
      const bytes = await port.download((p) => {
        // A late progress tick can't undo "ready".
        if (state.kind === "downloading") set({ kind: "downloading", version, percent: Math.max(0, Math.min(100, Math.round(p))) });
      });
      done(DOWNLOAD_TASK, true, bytes);
      set({ kind: "ready", version, notes });
    } catch (e) {
      o.log(`download failed: ${errText(e)}`);
      done(DOWNLOAD_TASK, false, 0);
      set({ kind: "error", during: "download", version });
    }
    return view();
  }

  function install(): UpdatesView {
    if (o.port && state.kind === "ready") {
      const { version } = state;
      // A failed install goes back to "didn't finish" with Try again, never a dead Restart now.
      o.port.install((e) => {
        o.log(`install failed: ${errText(e)}`);
        set({ kind: "error", during: "download", version });
      });
    }
    return view();
  }

  function setAuto(on: boolean): UpdatesView {
    o.saveAuto(on);
    const v = view();
    o.emit(v);
    return v;
  }

  function startSchedule(timer = { every: (ms: number, fn: () => void) => { const id = setInterval(fn, ms); return () => clearInterval(id); } }): () => void {
    if (!o.port) return () => {};
    const tick = (): void => {
      if (o.getAuto()) void check(false);
    };
    tick();
    return timer.every(CHECK_EVERY_MS, tick);
  }

  return { view, check, download, install, setAuto, startSchedule };
}
