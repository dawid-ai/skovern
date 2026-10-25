import { describe, expect, it } from "vitest";
import type { UpdateState, UpdatesView } from "../../../shared/updates.js";
import { noticeCopy, settingsCopy } from "./update-copy.js";

const view = (state: UpdateState, more: Partial<UpdatesView> = {}): UpdatesView => ({ current: "0.1.0", canUpdate: true, auto: true, state, ...more });

describe("update notice", () => {
  it("asks before downloading, shows progress, then asks to restart", () => {
    expect(noticeCopy(view({ kind: "available", version: "0.2.0", notes: "Faster." }))).toMatchObject({
      title: "A new Skovern is here (0.2.0).",
      body: "Faster.",
      action: { label: "Update now", op: "download" },
    });
    expect(noticeCopy(view({ kind: "downloading", version: "0.2.0", percent: 42 }))).toMatchObject({ title: "Getting the update… 42%", percent: 42 });
    expect(noticeCopy(view({ kind: "downloading", version: "0.2.0", percent: 42 }))?.action).toBeUndefined();
    expect(noticeCopy(view({ kind: "ready", version: "0.2.0", notes: "" }))).toMatchObject({ action: { label: "Restart now", op: "install" } });
  });

  it("M3: a failed download offers Try again; nothing shows for a failed check, checking, idle, or up to date", () => {
    expect(noticeCopy(view({ kind: "error", during: "download", version: "0.2.0" }))?.action).toEqual({ label: "Try again", op: "download" });
    for (const s of [{ kind: "error", during: "check" }, { kind: "checking", userStarted: false }, { kind: "idle" }, { kind: "none" }] as UpdateState[]) {
      expect(noticeCopy(view(s))).toBeNull();
    }
  });

  it("each message has its own key, so Later hides only that message", () => {
    const a = noticeCopy(view({ kind: "available", version: "0.2.0", notes: "" }))!.key;
    const b = noticeCopy(view({ kind: "available", version: "0.3.0", notes: "" }))!.key;
    const c = noticeCopy(view({ kind: "ready", version: "0.2.0", notes: "" }))!.key;
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("Settings → Updates", () => {
  it("M3: a dev build can't check and says why", () => {
    expect(settingsCopy(view({ kind: "idle" }, { canUpdate: false }))).toEqual({ status: "Updates work in the installed app.", action: null, checkDisabled: true });
  });

  it("M3: no second check while one is running or a download is under way", () => {
    expect(settingsCopy(view({ kind: "checking", userStarted: true })).checkDisabled).toBe(true);
    expect(settingsCopy(view({ kind: "downloading", version: "0.2.0", percent: 5 })).checkDisabled).toBe(true);
  });

  it("says what happened for each state", () => {
    expect(settingsCopy(view({ kind: "none" })).status).toBe("You're up to date.");
    expect(settingsCopy(view({ kind: "error", during: "check" })).status).toBe("Couldn't check just now. Check your internet connection and try again.");
    expect(settingsCopy(view({ kind: "error", during: "check" })).action).toEqual({ label: "Try again", op: "check" });
    expect(settingsCopy(view({ kind: "available", version: "0.2.0", notes: "" })).action).toEqual({ label: "Update now", op: "download" });
    expect(settingsCopy(view({ kind: "ready", version: "0.2.0", notes: "" })).action).toEqual({ label: "Restart now", op: "install" });
    expect(settingsCopy(view({ kind: "idle" }, { auto: false })).status).toBe("Automatic checks are off.");
  });
});
