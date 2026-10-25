import { getAppInfo, type AppInfo } from "@skovern/core";

/** `app:info`: the running app's own version, the same one the updater compares against. */
export function appInfo(app: { getVersion(): string }): AppInfo {
  return getAppInfo(app.getVersion());
}
