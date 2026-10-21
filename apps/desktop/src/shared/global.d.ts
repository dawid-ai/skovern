import type { AppInfo } from "@skovern/core";
import type { CurrentAccount, RequestResult, VerifyResult } from "./account.js";
import type { DmSendResult, DmThreadView, NewsPostView, PublishResultView, PublishVisibilityInput } from "./cloud.js";
import type { BrainStatusView, SaveBrainInput, SaveBrainResult, TestBrainResult } from "./brain.js";
import type { ConnectProbeView, LocalActionResult, LocalModelsView, LocalStatusView, PullProgressView, YourModelsView } from "./local.js";
import type { RunSkillResult, SandboxCheckResult, SkillView } from "./plugin.js";
import type { ActivitySummary, DateRange, ReceiptView } from "./receipts.js";
import type { ChatMeta, ChatSendResult, ChatStatusEvent, ChatTokenEvent, ChatView } from "./chat.js";
import type { OllamaLaunch, OllamaStatusView, SettingsView } from "./settings.js";

declare global {
  interface Window {
    skovern: {
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
      local: {
        status(): Promise<LocalStatusView>;
        rescan(): Promise<LocalStatusView>;
        models(): Promise<LocalModelsView>;
        pull(modelId: string): Promise<LocalActionResult>;
        /** 047: set the helper up if needed, start it, then get this catalog brain. */
        setUp(modelId: string): Promise<LocalActionResult>;
        /** 047: the set-up running right now, or null. */
        setUpStatus(): Promise<PullProgressView | null>;
        connect(address: string): Promise<ConnectProbeView>;
        classify(address: string): Promise<{ valid: boolean; offBox: boolean; endpoint: string | null }>;
        /** Listen for live pull progress. Returns an unsubscribe. */
        onPullProgress(cb: (p: PullProgressView) => void): () => void;
        downloadedModels(): Promise<YourModelsView>;
        deleteModel(filename: string): Promise<LocalActionResult>;
        freeMemory(): Promise<{ freed: boolean }>;
        revealModels(): Promise<void>;
      };
      receipts: {
        list(range?: DateRange): Promise<ReceiptView[]>;
        activity(): Promise<ActivitySummary>;
        exportCsv(rows: ReceiptView[]): Promise<string | null>;
      };
      settings: {
        get(): Promise<SettingsView>;
        setOllamaLaunch(value: OllamaLaunch): Promise<SettingsView>;
        ollamaStatus(): Promise<OllamaStatusView>;
        /** Start Ollama once, on the user's explicit request (does not change the pref). */
        startOllama(): Promise<{ running: boolean }>;
      };
      chat: {
        list(): Promise<ChatMeta[]>;
        get(id: string): Promise<ChatView | null>;
        "new"(): Promise<ChatMeta>;
        rename(id: string, title: string): Promise<void>;
        delete(id: string): Promise<void>;
        send(chatId: string, text: string): Promise<ChatSendResult>;
        stop(chatId: string): Promise<void>;
        /** Listen for streamed reply tokens. Returns an unsubscribe. */
        onToken(cb: (e: ChatTokenEvent) => void): () => void;
        /** Listen for launch/prepare status lines. Empty phase clears it. Returns an unsubscribe. */
        onStatus(cb: (e: ChatStatusEvent) => void): () => void;
      };
    };
  }
}

export {};
