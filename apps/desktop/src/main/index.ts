import { app, BrowserWindow, Menu, Tray, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electronUpdater from "electron-updater";
import {
  anthropicProvider,
  createAccountClient,
  createDmClient,
  createNewsClient,
  createPublishClient,
  createRouter,
  getAppInfo,
  openRouterProvider,
  type Provider,
  type ProviderId,
  type Router,
} from "@deskhand/core";
import { explainCapability } from "@deskhand/plugin-sdk";
import { registerTrusted } from "./ipc.js";
import { clearSession, loadSession, saveSession } from "./session.js";
import { brainStatus, loadBrain, saveBrain } from "./keys.js";
import { fileFetchSink, fileReceiptSink, readReceipts, receiptedFetch } from "./receipts.js";
import { runPlugin, sandboxCheck } from "./plugin-host.js";
import { claudeCliProvider } from "./claude-cli.js";
import { helloManifest } from "../plugins/hello/manifest.js";
import { aiVisibilityManifest } from "../plugins/ai-visibility/manifest.js";
import type { CurrentAccount, RequestResult, VerifyResult } from "../shared/account.js";
import type { DmSendResult, DmThreadView, NewsPostView, PublishResultView } from "../shared/cloud.js";
import type { BrainStatusView, SaveBrainResult, TestBrainResult } from "../shared/brain.js";
import type { RunSkillResult, SandboxCheckResult, SkillView } from "../shared/plugin.js";
import type { ReceiptView } from "../shared/receipts.js";

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

// Brain base-URL overrides are a dev/test seam (point the real adapter at a mock).
// Honored ONLY in unpackaged builds — a shipped app must never let an env var
// redirect the user's key + prompt to an arbitrary host (mirror of DEV_SERVER_URL).
const BRAIN_BASE = {
  openrouter: app.isPackaged ? undefined : process.env["DESKHAND_OPENROUTER_BASE_URL"],
  anthropic: app.isPackaged ? undefined : process.env["DESKHAND_ANTHROPIC_BASE_URL"],
};
// The Claude Code CLI brain. In a shipped app it's always the real `claude` on PATH;
// the bin/args overrides are dev/test seams (point at a stub so CI needs no
// subscription) honored ONLY unpackaged — mirror of BRAIN_BASE. A packaged app must
// never let an env var redirect the user's prompt to an arbitrary executable.
const CLAUDE_BIN = (!app.isPackaged && process.env["DESKHAND_CLAUDE_BIN"]) || "claude";
function devClaudeArgs(): string[] | undefined {
  if (app.isPackaged) return undefined;
  const raw = process.env["DESKHAND_CLAUDE_ARGS"];
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((a) => typeof a === "string") ? (parsed as string[]) : undefined;
  } catch {
    return undefined;
  }
}
// A skill on the CLI brain makes several sequential `claude -p` calls, each slower
// than an HTTP call — the 30s per-run cap would kill a legit run. Give CLI runs room.
const CLI_RUN_TIMEOUT_MS = 300_000;
const CANT_REACH = "Couldn't connect right now. Try again in a moment.";

// Skills: the bundled fixtures for v1. Loopback + a mock target are dev/test seams
// (mirror of DEV_SERVER_URL) — a shipped app is https-only and reaches real pages.
const SKILLS = [helloManifest, aiVisibilityManifest];
const PLUGIN_ALLOW_LOOPBACK = !app.isPackaged && process.env["DESKHAND_PLUGIN_ALLOW_LOOPBACK"] === "1";
const HELLO_URL = (!app.isPackaged && process.env["DESKHAND_HELLO_URL"]) || "https://example.com";

// The Hello fixture uses only `fetch`, so it runs with a stub brain that refuses.
// A skill can't reach it anyway unless its manifest declared `brain`.
const noBrain: Router = { generate: () => Promise.reject(new Error("no brain configured")) };

// The user's configured brain as a router, or null if none is set up. One place
// both "Test my brain" and a brain-using skill get their brain — the key stays in
// safeStorage (loadBrain), never the renderer, and every call is receipted.
function buildRouter(): Router | null {
  const brain = loadBrain();
  if (!brain) return null;
  const provider: Provider =
    brain.provider === "claude-cli"
      ? claudeCliProvider({ bin: CLAUDE_BIN, baseArgs: devClaudeArgs(), model: brain.model })
      : brain.provider === "anthropic"
        ? anthropicProvider({ apiKey: brain.key, model: brain.model, baseURL: BRAIN_BASE.anthropic })
        : openRouterProvider({ apiKey: brain.key, model: brain.model, baseURL: BRAIN_BASE.openrouter });
  const providers: Partial<Record<ProviderId, Provider>> = {};
  providers[brain.provider] = provider;
  return createRouter({ providers, defaultProvider: brain.provider, sink: fileReceiptSink() });
}

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

    // First-party cloud calls are egress too. Each client gets a receipted `fetch`
    // wrapper (loop 015): a durable "sent" line lands before any byte leaves, so
    // the Receipts panel shows EVERY outbound byte — not just model + plugin calls.
    // Metadata only (host + label + bytes), never a key, token, or body.
    const fetchSink = fileFetchSink();

    const account = createAccountClient(API_BASE, receiptedFetch(fetchSink, "Deskhand: sign-in"));

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

    const news = createNewsClient(API_BASE, receiptedFetch(fetchSink, "Deskhand: news"));
    registerTrusted(TRUST, "news:list", async (): Promise<NewsPostView[]> => {
      try {
        return await news.list();
      } catch {
        return [];
      }
    });

    const dm = createDmClient(API_BASE, receiptedFetch(fetchSink, "Deskhand: messages"));
    registerTrusted(TRUST, "dm:send", async (rawMessage: unknown): Promise<DmSendResult> => {
      const message = typeof rawMessage === "string" ? rawMessage : "";
      // The bearer token stays in main (keychain) — the renderer never holds it.
      const session = loadSession();
      if (!session) return { ok: false, message: "Please sign in first." };
      try {
        return await dm.send(session.token, message);
      } catch {
        return { ok: false, message: CANT_REACH };
      }
    });

    // Publish an AI Visibility result to a public link. The renderer passes only
    // the result; the session token stays in main (keychain). Outbound + opt-in:
    // only fires on the user's explicit Publish click.
    const publish = createPublishClient(API_BASE, receiptedFetch(fetchSink, "Deskhand: publish"));
    registerTrusted(TRUST, "visibility:publish", async (raw: unknown): Promise<PublishResultView> => {
      const o = (raw ?? {}) as { business?: unknown; score?: unknown; competitors?: unknown };
      const business = typeof o.business === "string" ? o.business : "";
      const score = typeof o.score === "number" ? o.score : NaN;
      const competitors = Array.isArray(o.competitors) ? o.competitors.filter((c): c is string => typeof c === "string") : [];
      if (!business.trim() || !Number.isFinite(score)) {
        return { ok: false, message: "That result looks off — run the check again." };
      }
      const session = loadSession();
      if (!session) return { ok: false, message: "Sign in first to publish your result." };
      try {
        return await publish.publishVisibility(session.token, { business, score, competitors });
      } catch {
        return { ok: false, message: CANT_REACH };
      }
    });

    registerTrusted(TRUST, "dm:thread", async (): Promise<DmThreadView> => {
      const session = loadSession();
      if (!session) return { messages: [], unread: 0 };
      try {
        return await dm.thread(session.token);
      } catch {
        return { messages: [], unread: 0 };
      }
    });

    registerTrusted(TRUST, "dm:read", async (): Promise<void> => {
      const session = loadSession();
      if (!session) return;
      try {
        await dm.markRead(session.token);
      } catch {
        // best-effort; the badge just lingers until the next successful mark
      }
    });

    // "What leaves your machine" — the panel reads the on-disk egress log. Trusted,
    // READ-ONLY: returns parsed metadata (bounded, malformed-tolerant); nothing from
    // the renderer is accepted, and there's no way to trigger egress or edit the log.
    registerTrusted(TRUST, "receipts:list", (): Promise<ReceiptView[]> => readReceipts());

    // Brain (model router). The key lives in the keychain (keys.ts) and never
    // leaves main; the renderer only picks a brain and sees the result + receipt.
    registerTrusted(TRUST, "brain:status", (): BrainStatusView => brainStatus());

    registerTrusted(TRUST, "brain:save", (raw: unknown): SaveBrainResult => {
      const input = (raw ?? {}) as { provider?: unknown; key?: unknown; model?: unknown };
      const provider: ProviderId =
        input.provider === "anthropic" ? "anthropic" : input.provider === "claude-cli" ? "claude-cli" : "openrouter";
      const key = typeof input.key === "string" ? input.key.trim() : "";
      const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
      // The subscription brain has no key; the API-key brains require one.
      if (provider !== "claude-cli" && !key) return { ok: false, message: "Paste your key first." };
      // No real API key is this long — cap it so a bad/compromised renderer can't
      // write a multi-MB blob into the keychain file.
      if (key.length > 8192) return { ok: false, message: "That doesn't look like a key." };
      try {
        saveBrain({ provider, key, model });
        return { ok: true, message: "Brain saved." };
      } catch {
        // safeStorage unavailable — we refuse to write a key in plaintext
        return { ok: false, message: "Couldn't store the key safely on this computer." };
      }
    });

    registerTrusted(TRUST, "brain:test", async (): Promise<TestBrainResult> => {
      const router = buildRouter();
      if (!router) return { ok: false, message: "Add a brain first, then test it." };
      try {
        const { text, receipt } = await router.generate({
          task: "Test my brain",
          prompt: "Say a short, friendly hello so I know you're working.",
        });
        return { ok: true, message: "Your brain answered!", reply: text, receipt };
      } catch {
        // The subscription brain has no key — if it failed, the CLI likely isn't there.
        const msg =
          loadBrain()?.provider === "claude-cli"
            ? "We couldn't reach Claude Code on this computer. Is it installed and signed in?"
            : "Your brain didn't answer. Check the key and try again.";
        return { ok: false, message: msg };
      }
    });

    // Skills. `list` shows each skill's permission card (exactly what the broker
    // enforces); `run` executes it in the sandboxed host; `sandboxCheck` proves the
    // lockdown on the real forked child (Electron binary under the Permission Model).
    registerTrusted(TRUST, "plugin:list", (): SkillView[] =>
      SKILLS.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        permissions: m.capabilities.map(explainCapability),
      })),
    );

    registerTrusted(TRUST, "plugin:run", async (rawId: unknown, rawInput: unknown): Promise<RunSkillResult> => {
      const id = typeof rawId === "string" ? rawId : "";
      const manifest = SKILLS.find((m) => m.id === id);
      if (!manifest) return { ok: false, message: "That skill isn't here." };

      // A skill that declares "brain" runs on the user's real configured brain; if
      // none is set up, don't run it — say so plainly instead of failing opaquely.
      let brain = noBrain;
      let runTimeoutMs: number | undefined;
      if (manifest.capabilities.includes("brain")) {
        const router = buildRouter();
        if (!router) return { ok: false, message: "Connect a brain in Settings first, then try again." };
        brain = router;
        // The CLI brain is much slower per call — give a multi-call skill room to finish.
        if (loadBrain()?.provider === "claude-cli") runTimeoutMs = CLI_RUN_TIMEOUT_MS;
      }

      // Hello reads a fixed page; brain skills take the user's input (a JSON blob).
      const input = manifest.id === "hello" ? HELLO_URL : typeof rawInput === "string" ? rawInput : "";
      // Bound untrusted renderer input before it reaches the child (the per-call cap
      // downstream only guards derived prompts, not this buffer). 64KB mirrors MAX_ARG_BYTES.
      if (input.length > 64 * 1024) return { ok: false, message: "That was too much to check at once." };
      try {
        // Live progress ("Question N of 5…") is main→renderer only; the host hands us
        // pre-validated integers, we just forward them to the window that asked.
        const onProgress = (step: number, total: number): void =>
          mainWindow?.webContents.send("plugin:progress", { step, total });
        return await runPlugin({ manifest, brain, allowLoopback: PLUGIN_ALLOW_LOOPBACK, runTimeoutMs, onProgress }, input);
      } catch {
        return { ok: false, message: "That skill couldn't run." };
      }
    });

    registerTrusted(TRUST, "plugin:sandboxCheck", (): Promise<SandboxCheckResult> => sandboxCheck());

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
