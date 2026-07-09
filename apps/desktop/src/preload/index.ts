import { contextBridge, ipcRenderer } from "electron";
import type { AppInfo } from "@deskhand/core";

const api = {
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke("app:info") as Promise<AppInfo>,
};

contextBridge.exposeInMainWorld("deskhand", api);

export type DeskhandApi = typeof api;
