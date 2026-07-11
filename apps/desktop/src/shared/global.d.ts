import type { AppInfo } from "@deskhand/core";
import type { CurrentAccount, RequestResult, VerifyResult } from "./account.js";
import type { DmSendResult, DmThreadView, NewsPostView, PublishResultView, PublishVisibilityInput } from "./cloud.js";
import type { BrainStatusView, SaveBrainInput, SaveBrainResult, TestBrainResult } from "./brain.js";
import type { RunSkillResult, SandboxCheckResult, SkillView } from "./plugin.js";
import type { ReceiptView } from "./receipts.js";

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
        thread(): Promise<DmThreadView>;
        read(): Promise<void>;
      };
      brain: {
        status(): Promise<BrainStatusView>;
        save(input: SaveBrainInput): Promise<SaveBrainResult>;
        test(): Promise<TestBrainResult>;
      };
      plugins: {
        list(): Promise<SkillView[]>;
        run(id: string, input?: string): Promise<RunSkillResult>;
        sandboxCheck(): Promise<SandboxCheckResult>;
        /** Listen for live run progress ("step N of total"). Returns an unsubscribe. */
        onProgress(cb: (p: { step: number; total: number }) => void): () => void;
      };
      visibility: {
        publish(input: PublishVisibilityInput): Promise<PublishResultView>;
      };
      receipts: {
        list(): Promise<ReceiptView[]>;
      };
    };
  }
}

export {};
