import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electronUpdater from "electron-updater";
import { createAccountClient, getAppInfo } from "@deskhand/core";
import { registerTrusted } from "./ipc.js";
import { clearSession, loadSession, saveSession } from "./session.js";
import type { CurrentAccount, RequestResult, VerifyResult } from "../shared/account.js";

const { autoUpdater } = electronUpdater;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dev server URL is only ever honored in unpackaged (dev) builds
const DEV_SERVER_URL = app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"];
const RENDERER_INDEX_PATH = path.join(__dirname, "../renderer/index.html");
const RENDERER_INDEX_URL = pathToFileURL(RENDERER_INDEX_PATH).href;
const TRUST = { devServerUrl: DEV_SERVER_URL, rendererIndexUrl: RENDERER_INDEX_URL };

// The core auth client is the ONLY thing that talks to the cloud API. Local
// server by default; a hosted URL is injected via env when one exists.
const API_BASE = process.env["DESKHAND_API_URL"] ?? "http://127.0.0.1:8787";
const CANT_REACH = "Couldn't connect right now. Try again in a moment.";

// ponytail: placeholder 16x16 orange square until the real icon exists
const TRAY_ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJElEQVR4nGN4UaXH8KJK7z+ZmIESzWA8asCoAaMGUNEAirIzALsgiyMIAIRAAAAAAElFTkSuQmCC";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 640,
    title: "Deskhand",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // security invariants: the shell never navigates away or opens windows
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // closing the window keeps Deskhand in the tray — but only if the tray exists
  mainWindow.on("close", (event) => {
    if (!quitting && tray !== null) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (DEV_SERVER_URL !== undefined) {
    void mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(RENDERER_INDEX_PATH);
  }
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
  tray.setToolTip("Deskhand");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Deskhand",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      { type: "separator" },
      {
        label: "Quit Deskhand",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => mainWindow?.show());
}

function checkForUpdatesSafely(): void {
  // contract 001: updater is wired, dry-run — real checks only make sense packaged
  if (!app.isPackaged) {
    console.log("[updater] dev build — skipping update check");
    return;
  }
  autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
    console.warn("[updater] check failed (offline is fine):", error);
  });
}

app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  // tray app: stay alive — unless there is no tray to reopen from
  if (tray === null) app.quit();
});

app
  .whenReady()
  .then(() => {
    registerTrusted(TRUST, "app:info", () => getAppInfo());

    const account = createAccountClient(API_BASE);

    registerTrusted(TRUST, "account:request", async (rawEmail: unknown): Promise<RequestResult> => {
      const email = typeof rawEmail === "string" ? rawEmail : "";
      try {
        await account.requestMagicLink(email);
        return { ok: true, message: "Check your email for a sign-in link." };
      } catch {
        return { ok: false, message: CANT_REACH };
      }
    });

    registerTrusted(TRUST, "account:verify", async (rawToken: unknown): Promise<VerifyResult> => {
      const token = typeof rawToken === "string" ? rawToken : "";
      try {
        const session = await account.verifyMagicLink(token);
        if (!session) return { ok: false, message: "That link didn't work. Ask for a new one." };
        try {
          saveSession({ token: session.token, ogNumber: session.ogNumber });
        } catch {
          // no OS keychain → signed in for this run only, not persisted
          console.warn("[account] session not persisted (secure storage unavailable)");
        }
        return { ok: true, ogNumber: session.ogNumber, message: "You're in." };
      } catch {
        return { ok: false, message: CANT_REACH };
      }
    });

    registerTrusted(TRUST, "account:current", (): CurrentAccount | null => {
      const session = loadSession();
      return session ? { ogNumber: session.ogNumber } : null;
    });

    registerTrusted(TRUST, "account:signOut", (): void => {
      clearSession();
    });

    createWindow();
    try {
      createTray();
    } catch (error) {
      // no tray → closing the window quits instead of trapping the app headless
      tray = null;
      console.warn("[tray] unavailable — window close will quit:", error);
    }
    checkForUpdatesSafely();
  })
  .catch((error: unknown) => {
    console.error("[main] startup failed:", error);
    quitting = true;
    app.quit();
  });
