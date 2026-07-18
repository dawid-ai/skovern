import { contextBridge, ipcRenderer } from "electron";
import type { AppInfo } from "@skovern/core";
import type { CurrentAccount, RequestResult, VerifyResult } from "../shared/account.js";
import type { DmSendResult, DmThreadView, NewsPostView, PublishResultView, PublishVisibilityInput } from "../shared/cloud.js";
import type { BrainStatusView, SaveBrainInput, SaveBrainResult, TestBrainResult } from "../shared/brain.js";
import type { LocalActionResult, LocalModelsView, LocalStatusView, PullProgressView, YourModelsView } from "../shared/local.js";
import type { RunSkillResult, SandboxCheckResult, SkillView } from "../shared/plugin.js";
import type { ActivitySummary, DateRange, ReceiptView } from "../shared/receipts.js";
import type { ChatMeta, ChatSendResult, ChatStatusEvent, ChatTokenEvent, ChatView } from "../shared/chat.js";
import type { OllamaLaunch, OllamaStatusView, SettingsView } from "../shared/settings.js";

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:info") as Promise<AppInfo>,
  account: {
    request: (email: string): Promise<RequestResult> =>
      ipcRenderer.invoke("account:request", email) as Promise<RequestResult>,
    verify: (token: string): Promise<VerifyResult> =>
      ipcRenderer.invoke("account:verify", token) as Promise<VerifyResult>,
    current: (): Promise<CurrentAccount | null> =>
      ipcRenderer.invoke("account:current") as Promise<CurrentAccount | null>,
    signOut: (): Promise<void> => ipcRenderer.invoke("account:signOut") as Promise<void>,
  },
  news: {
    list: (): Promise<NewsPostView[]> => ipcRenderer.invoke("news:list") as Promise<NewsPostView[]>,
  },
  dm: {
    send: (message: string): Promise<DmSendResult> =>
      ipcRenderer.invoke("dm:send", message) as Promise<DmSendResult>,
    thread: (): Promise<DmThreadView> => ipcRenderer.invoke("dm:thread") as Promise<DmThreadView>,
    read: (): Promise<void> => ipcRenderer.invoke("dm:read") as Promise<void>,
  },
  brain: {
    status: (): Promise<BrainStatusView> =>
      ipcRenderer.invoke("brain:status") as Promise<BrainStatusView>,
    save: (input: SaveBrainInput): Promise<SaveBrainResult> =>
      ipcRenderer.invoke("brain:save", input) as Promise<SaveBrainResult>,
    test: (): Promise<TestBrainResult> => ipcRenderer.invoke("brain:test") as Promise<TestBrainResult>,
  },
  plugins: {
    list: (): Promise<SkillView[]> => ipcRenderer.invoke("plugin:list") as Promise<SkillView[]>,
    run: (id: string, input?: string): Promise<RunSkillResult> =>
      ipcRenderer.invoke("plugin:run", id, input ?? "") as Promise<RunSkillResult>,
    sandboxCheck: (): Promise<SandboxCheckResult> =>
      ipcRenderer.invoke("plugin:sandboxCheck") as Promise<SandboxCheckResult>,
    // Listen-only: the renderer subscribes to progress; it can never emit on this
    // channel. Re-validate the shape here too (two integers) so a malformed payload
    // never reaches React. Returns an unsubscribe the view calls on unmount.
    onProgress: (cb: (p: { step: number; total: number }) => void): (() => void) => {
      const handler = (_event: unknown, payload: unknown): void => {
        const p = (payload ?? {}) as { step?: unknown; total?: unknown };
        if (Number.isInteger(p.step) && Number.isInteger(p.total)) {
          cb({ step: p.step as number, total: p.total as number });
        }
      };
      ipcRenderer.on("plugin:progress", handler);
      return () => ipcRenderer.removeListener("plugin:progress", handler);
    },
  },
  visibility: {
    publish: (input: PublishVisibilityInput): Promise<PublishResultView> =>
      ipcRenderer.invoke("visibility:publish", input) as Promise<PublishResultView>,
  },
  local: {
    status: (): Promise<LocalStatusView> => ipcRenderer.invoke("local:status") as Promise<LocalStatusView>,
    rescan: (): Promise<LocalStatusView> => ipcRenderer.invoke("local:rescan") as Promise<LocalStatusView>,
    models: (): Promise<LocalModelsView> => ipcRenderer.invoke("local:models") as Promise<LocalModelsView>,
    pull: (modelId: string): Promise<LocalActionResult> =>
      ipcRenderer.invoke("local:pull", modelId) as Promise<LocalActionResult>,
    // "Your models" (loop 041): list downloaded + loaded, delete to reclaim disk, free VRAM.
    downloadedModels: (): Promise<YourModelsView> => ipcRenderer.invoke("local:downloadedModels") as Promise<YourModelsView>,
    deleteModel: (filename: string): Promise<LocalActionResult> =>
      ipcRenderer.invoke("local:deleteModel", filename) as Promise<LocalActionResult>,
    freeMemory: (): Promise<{ freed: boolean }> => ipcRenderer.invoke("local:freeMemory") as Promise<{ freed: boolean }>,
    // Listen-only: the renderer subscribes to pull progress; it can never emit here.
    // Re-validate the shape so a malformed payload never reaches React. Returns an
    // unsubscribe the view calls on unmount.
    onPullProgress: (cb: (p: PullProgressView) => void): (() => void) => {
      const handler = (_event: unknown, payload: unknown): void => {
        const p = (payload ?? {}) as Record<string, unknown>;
        if (
          typeof p["modelId"] === "string" &&
          typeof p["percent"] === "number" &&
          typeof p["status"] === "string" &&
          typeof p["done"] === "boolean" &&
          typeof p["ok"] === "boolean"
        ) {
          cb({
            modelId: p["modelId"],
            percent: p["percent"],
            status: p["status"],
            done: p["done"],
            ok: p["ok"],
          });
        }
      };
      ipcRenderer.on("local:pullProgress", handler);
      return () => ipcRenderer.removeListener("local:pullProgress", handler);
    },
  },
  chat: {
    list: (): Promise<ChatMeta[]> => ipcRenderer.invoke("chat:list") as Promise<ChatMeta[]>,
    get: (id: string): Promise<ChatView | null> => ipcRenderer.invoke("chat:get", id) as Promise<ChatView | null>,
    new: (): Promise<ChatMeta> => ipcRenderer.invoke("chat:new") as Promise<ChatMeta>,
    rename: (id: string, title: string): Promise<void> => ipcRenderer.invoke("chat:rename", id, title) as Promise<void>,
    delete: (id: string): Promise<void> => ipcRenderer.invoke("chat:delete", id) as Promise<void>,
    send: (chatId: string, text: string): Promise<ChatSendResult> =>
      ipcRenderer.invoke("chat:send", { chatId, text }) as Promise<ChatSendResult>,
    stop: (chatId: string): Promise<void> => ipcRenderer.invoke("chat:stop", chatId) as Promise<void>,
    // Listen-only: the renderer subscribes to streamed tokens; it can never emit here.
    // Re-validate the shape at the trust boundary so a malformed payload never reaches
    // React. Returns an unsubscribe the view calls on unmount.
    onToken: (cb: (e: ChatTokenEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: unknown): void => {
        const p = (payload ?? {}) as Record<string, unknown>;
        if (typeof p["chatId"] === "string" && typeof p["messageId"] === "string" && typeof p["delta"] === "string") {
          cb({ chatId: p["chatId"], messageId: p["messageId"], delta: p["delta"] });
        }
      };
      ipcRenderer.on("chat:token", handler);
      return () => ipcRenderer.removeListener("chat:token", handler);
    },
    // Listen-only: launch/prepare status lines (loop 033 Issue 4). Shape re-validated at the
    // boundary; an empty `phase` clears the indicator. Returns an unsubscribe.
    onStatus: (cb: (e: ChatStatusEvent) => void): (() => void) => {
      const handler = (_event: unknown, payload: unknown): void => {
        const p = (payload ?? {}) as Record<string, unknown>;
        if (typeof p["chatId"] === "string" && typeof p["phase"] === "string") {
          cb({ chatId: p["chatId"], phase: p["phase"] });
        }
      };
      ipcRenderer.on("chat:status", handler);
      return () => ipcRenderer.removeListener("chat:status", handler);
    },
  },
  settings: {
    get: (): Promise<SettingsView> => ipcRenderer.invoke("settings:get") as Promise<SettingsView>,
    setOllamaLaunch: (value: OllamaLaunch): Promise<SettingsView> =>
      ipcRenderer.invoke("settings:setOllamaLaunch", value) as Promise<SettingsView>,
    ollamaStatus: (): Promise<OllamaStatusView> => ipcRenderer.invoke("ollama:status") as Promise<OllamaStatusView>,
    // Start Ollama once, on the user's explicit request (the in-chat CTA). Ephemeral — does
    // not change the persisted launch pref. Resolves with whether it came up.
    startOllama: (): Promise<{ running: boolean }> => ipcRenderer.invoke("ollama:start") as Promise<{ running: boolean }>,
  },
  receipts: {
    // No range → the recent window; a range → the full retained history for those dates.
    list: (range?: DateRange): Promise<ReceiptView[]> =>
      ipcRenderer.invoke("receipts:list", range ?? {}) as Promise<ReceiptView[]>,
    activity: (): Promise<ActivitySummary> => ipcRenderer.invoke("receipts:activity") as Promise<ActivitySummary>,
    // Export selected rows to CSV (main sanitizes + writes). Resolves to the path
    // written, or null if the user cancelled or nothing was selected.
    exportCsv: (rows: ReceiptView[]): Promise<string | null> =>
      ipcRenderer.invoke("receipts:exportCsv", rows) as Promise<string | null>,
  },
};

contextBridge.exposeInMainWorld("skovern", api);

export type SkovernApi = typeof api;
