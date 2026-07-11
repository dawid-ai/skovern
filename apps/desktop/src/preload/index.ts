import { contextBridge, ipcRenderer } from "electron";
import type { AppInfo } from "@deskhand/core";
import type { CurrentAccount, RequestResult, VerifyResult } from "../shared/account.js";
import type { DmSendResult, DmThreadView, NewsPostView, PublishResultView, PublishVisibilityInput } from "../shared/cloud.js";
import type { BrainStatusView, SaveBrainInput, SaveBrainResult, TestBrainResult } from "../shared/brain.js";
import type { RunSkillResult, SandboxCheckResult, SkillView } from "../shared/plugin.js";

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
  },
  visibility: {
    publish: (input: PublishVisibilityInput): Promise<PublishResultView> =>
      ipcRenderer.invoke("visibility:publish", input) as Promise<PublishResultView>,
  },
};

contextBridge.exposeInMainWorld("deskhand", api);

export type DeskhandApi = typeof api;
