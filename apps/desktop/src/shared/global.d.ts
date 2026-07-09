import type { AppInfo } from "@deskhand/core";

declare global {
  interface Window {
    deskhand: {
      getAppInfo(): Promise<AppInfo>;
    };
  }
}

export {};
