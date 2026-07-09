import type { AppInfo } from "@deskhand/core";
import type { CurrentAccount, RequestResult, VerifyResult } from "./account.js";

declare global {
  interface Window {
    deskhand: {
      getAppInfo(): Promise<AppInfo>;
      account: {
        request(email: string): Promise<RequestResult>;
        verify(token: string): Promise<VerifyResult>;
        current(): Promise<CurrentAccount | null>;
        signOut(): Promise<void>;
      };
    };
  }
}

export {};
