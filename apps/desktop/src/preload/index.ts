import { contextBridge, ipcRenderer } from "electron";
import type { AppInfo } from "@deskhand/core";
import type { CurrentAccount, RequestResult, VerifyResult } from "../shared/account.js";
import type { DmSendResult, NewsPostView } from "../shared/cloud.js";

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
  },
};

contextBridge.exposeInMainWorld("deskhand", api);

export type DeskhandApi = typeof api;
