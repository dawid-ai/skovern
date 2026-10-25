import type { UpdatesView } from "../../../shared/updates.js";

// What the update notice and Settings → Updates say for each state. Pure, so every state's
// words are unit-tested; the components only render this.

export type UpdateOp = "check" | "download" | "install";

export interface NoticeCopy {
  /** Changes when the message changes, so "Later" hides only the message it was clicked on. */
  key: string;
  title: string;
  body?: string;
  percent?: number;
  action?: { label: string; op: UpdateOp };
}

/** The small notice shown on every page, or null when there's nothing to tell. A check that
 *  failed in the background never shows here. */
export function noticeCopy(v: UpdatesView): NoticeCopy | null {
  const s = v.state;
  switch (s.kind) {
    case "available":
      return { key: `available:${s.version}`, title: `A new Skovern is here (${s.version}).`, body: s.notes, action: { label: "Update now", op: "download" } };
    case "downloading":
      return { key: `downloading:${s.version}`, title: `Getting the update… ${s.percent}%`, percent: s.percent };
    case "ready":
      return {
        key: `ready:${s.version}`,
        title: "The update is ready. Restart Skovern to finish.",
        body: "If you pick Later, it installs the next time you quit Skovern.",
        action: { label: "Restart now", op: "install" },
      };
    case "error":
      return s.during === "download"
        ? { key: `error:${s.version ?? ""}`, title: "The update didn't finish.", body: "Check your internet connection, then try again.", action: { label: "Try again", op: "download" } }
        : null;
    default:
      return null;
  }
}

export interface SettingsCopy {
  status: string;
  /** The step this state offers besides "Check for updates", if any. */
  action: { label: string; op: UpdateOp } | null;
  /** "Check for updates" can't run: nothing to update from, or already busy. */
  checkDisabled: boolean;
}

export function settingsCopy(v: UpdatesView): SettingsCopy {
  if (!v.canUpdate) return { status: "Updates work in the installed app.", action: null, checkDisabled: true };
  const s = v.state;
  switch (s.kind) {
    case "checking":
      return { status: "Checking for a new version…", action: null, checkDisabled: true };
    case "none":
      return { status: "You're up to date.", action: null, checkDisabled: false };
    case "available":
      return { status: `Version ${s.version} is ready to get.`, action: { label: "Update now", op: "download" }, checkDisabled: false };
    case "downloading":
      return { status: `Getting the update… ${s.percent}%`, action: null, checkDisabled: true };
    case "ready":
      return { status: `Version ${s.version} is downloaded. Restart Skovern to finish.`, action: { label: "Restart now", op: "install" }, checkDisabled: true };
    case "error":
      return s.during === "download"
        ? { status: "The update didn't finish.", action: { label: "Try again", op: "download" }, checkDisabled: false }
        : { status: "Couldn't check just now. Check your internet connection and try again.", action: null, checkDisabled: false };
    default:
      return { status: v.auto ? "Skovern looks for new versions by itself." : "Automatic checks are off.", action: null, checkDisabled: false };
  }
}
