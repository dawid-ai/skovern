import type { AppInfo } from "@deskhand/core";
import type { CurrentAccount, RequestResult, VerifyResult } from "./account.js";
import type { DmSendResult, NewsPostView } from "./cloud.js";

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
      news: {
        list(): Promise<NewsPostView[]>;
      };
      dm: {
        send(message: string): Promise<DmSendResult>;
      };
    };
  }
}

export {};
