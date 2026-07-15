import { app, BrowserWindow, Menu, Tray, dialog, nativeImage } from "electron";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
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
  localProvider,
  openRouterProvider,
  type Provider,
  type ProviderId,
  type PullProgress,
  type Router,
} from "@deskhand/core";
import { explainCapability } from "@deskhand/plugin-sdk";
import { registerTrusted } from "./ipc.js";
import { clearSession, loadSession, saveSession } from "./session.js";
import { brainStatus, loadBrain, saveBrain } from "./keys.js";
import { fileFetchSink, fileReceiptSink, readActivityIndex, readReceipts, readReceiptsInRange, receiptedFetch } from "./receipts.js";
import { toCsv } from "./csv.js";
import { runPlugin, sandboxCheck } from "./plugin-host.js";
import { claudeCliProvider } from "./claude-cli.js";
import { disposeLocal, downloadedEmbeddedModelId, embeddedFilenames, engineForModel, isEmbeddedModel, localModels, localStatus, makeEngine, pullModel } from "./local.js";
import { appendMessage, createTokenCoalescer, deleteChat, getChat, listChats, newChat, renameChat, sendChatToken } from "./chat-store.js";
import { pickSelfReliantFallback } from "./brain-fallback.js";
import { sweepOrphanParts } from "./download.js";
import { initialNewness, observeThread } from "./dm-newness.js";
import { helloManifest } from "../plugins/hello/manifest.js";
import { aiVisibilityManifest } from "../plugins/ai-visibility/manifest.js";
import type { CurrentAccount, RequestResult, VerifyResult } from "../shared/account.js";
import type { DmSendResult, DmThreadView, NewsPostView, PublishResultView } from "../shared/cloud.js";
import type { BrainStatusView, SaveBrainResult, TestBrainResult } from "../shared/brain.js";
import type { LocalActionResult, LocalModelsView, LocalStatusView, PullProgressView } from "../shared/local.js";
import type { RunSkillResult, SandboxCheckResult, SkillView } from "../shared/plugin.js";
import type { ActivitySummary, ReceiptView } from "../shared/receipts.js";
import type { ChatMessage, ChatMeta, ChatSendResult, ChatView } from "../shared/chat.js";

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

// Receipts calendar "today" and CSV export path — dev/test seams (mirror of
// DEV_SERVER_URL), honored ONLY unpackaged so the e2e day-grid is fixed on any runner
// and the export asserts file content without the OS save dialog. Production uses the
// real clock and the real dialog.
const NOW_OVERRIDE = (!app.isPackaged && process.env["DESKHAND_NOW"]) || undefined;
const EXPORT_PATH_OVERRIDE = (!app.isPackaged && process.env["DESKHAND_EXPORT_PATH"]) || undefined;
function todayKey(): string {
  const base = NOW_OVERRIDE ? new Date(NOW_OVERRIDE) : new Date();
  const when = Number.isNaN(base.getTime()) ? new Date() : base;
  return when.toISOString().slice(0, 10); // YYYY-MM-DD (UTC), matches the index's day keys
}

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
const noBrain: Router = {
  generate: () => Promise.reject(new Error("no brain configured")),
  generateStream: () => Promise.reject(new Error("no brain configured")),
};

// Development visibility: log the chat/brain lifecycle to the terminal so a dev running
// `pnpm dev` can SEE what's happening (inputs, which brain, stream start, result/error).
// Inert (no-op) in a packaged app — a florist never sees a console. (Dawid asked for
// terminal visibility while debugging; a persistent in-app "live log" window is a
// possible follow-up.)
function devlog(...args: unknown[]): void {
  if (!app.isPackaged) console.log("[chat]", ...args);
}

// Redact anything that looks like a secret before it can reach a dev log — the "never a
// key in a log" invariant holds even in dev, even on Dawid's own machine.
function scrubSecrets(s: string): string {
  return s.replace(/\b(sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]+)/g, "***");
}

// Wrap a provider so the REAL failure reason is visible in dev — the router deliberately
// swallows the provider error (it can carry a key/prompt) and rethrows a generic "brain X
// failed", so without this the actual cause (Ollama down, native crash, timeout) is lost.
// On-machine providers have no key → log the full message; a cloud error is logged by
// class only (its message could carry request detail), and every line is scrubbed.
function withDevErrorLog(provider: Provider): Provider {
  if (app.isPackaged) return provider;
  const onErr = (label: string, e: unknown): never => {
    const detail =
      provider.onMachine === true
        ? scrubSecrets(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
        : `${e instanceof Error ? e.name : "Error"} (cloud brain — detail hidden)`;
    console.error(`[chat] provider.${label} failed:`, detail);
    throw e;
  };
  return {
    ...provider,
    generate: (prompt) => provider.generate(prompt).catch((e) => onErr("generate", e)),
    generateStream: provider.generateStream
      ? (prompt, onDelta, signal) => provider.generateStream!(prompt, onDelta, signal).catch((e) => onErr("generateStream", e))
      : undefined,
  };
}

// The user's configured brain as a router, or null if none is set up. One place
// both "Test my brain" and a brain-using skill get their brain — the key stays in
// safeStorage (loadBrain), never the renderer, and every call is receipted.
function buildRouter(): Router | null {
  const brain = loadBrain();
  if (!brain) return null;
  const provider: Provider =
    brain.provider === "local"
      ? // A local model has no model id → no brain to run; guard with a clear id. The
        // dispatcher picks the embedded runtime for a gguf model, Ollama otherwise.
        localProvider(engineForModel(brain.model ?? ""), brain.model ?? "")
      : brain.provider === "claude-cli"
        ? claudeCliProvider({ bin: CLAUDE_BIN, baseArgs: devClaudeArgs(), model: brain.model })
        : brain.provider === "anthropic"
          ? anthropicProvider({ apiKey: brain.key, model: brain.model, baseURL: BRAIN_BASE.anthropic })
          : openRouterProvider({ apiKey: brain.key, model: brain.model, baseURL: BRAIN_BASE.openrouter });
  const providers: Partial<Record<ProviderId, Provider>> = {};
  providers[brain.provider] = withDevErrorLog(provider);
  return createRouter({ providers, defaultProvider: brain.provider, sink: fileReceiptSink() });
}

// A one-off router that runs a specific EMBEDDED model on the built-in runtime (no Ollama).
// The self-reliant fallback target — used when the configured Ollama brain is unreachable.
function buildLocalEmbeddedRouter(modelId: string): Router {
  const provider = withDevErrorLog(localProvider(engineForModel(modelId), modelId));
  return createRouter({ providers: { local: provider }, defaultProvider: "local", sink: fileReceiptSink() });
}

// STOPGAP self-reliance (full version → loop 032): if the active brain is a local OLLAMA
// model and Ollama isn't reachable, but a built-in embedded model is downloaded, answer
// with the embedded one instead of failing. Returns the router to use + an honest note
// when it swapped. Only the local-Ollama case triggers a check; every other brain is
// untouched (no added latency). Embedded/cloud/CLI brains return the normal router.
async function routerWithSelfReliantFallback(): Promise<{ router: Router | null; note: string }> {
  const brain = loadBrain();
  const normal = buildRouter();
  // Only a local Ollama brain can trigger a check (keeps every other brain latency-free).
  if (!brain || brain.provider !== "local" || isEmbeddedModel(brain.model ?? "")) {
    return { router: normal, note: "" };
  }
  const ollamaReady = await makeEngine().detect();
  const fallbackId = pickSelfReliantFallback(brain, false, ollamaReady, downloadedEmbeddedModelId());
  if (!fallbackId) return { router: normal, note: "" }; // Ollama up, or nothing to fall back to
  devlog(`Ollama unreachable → falling back to built-in embedded model ${fallbackId}`);
  return {
    router: buildLocalEmbeddedRouter(fallbackId),
    note: "Your usual brain wasn't available, so I used your built-in one on this computer.",
  };
}

// A warm, provider-aware failure message for when a brain call throws — so the user gets
// an ACTIONABLE hint ("Is Ollama running?") instead of a vague "didn't answer". Shared by
// "Test my brain" and chat so both stay honest and consistent. Never surfaces the raw
// error (which could carry a key/prompt) — that stays in main / the dev terminal.
function brainFailureMessage(): string {
  const brain = loadBrain();
  const p = brain?.provider;
  if (p === "claude-cli") return "We couldn't reach Claude Code on this computer. Is it installed and signed in?";
  if (p === "local") {
    // An embedded (on-device) model has nothing to do with Ollama — say so honestly,
    // rather than telling a no-Ollama florist to "start Ollama".
    return isEmbeddedModel(brain?.model ?? "")
      ? "We couldn't start the private brain on this computer. It may not be supported here yet, or the download didn't finish — try getting it again."
      : "We couldn't reach the local brain. Is Ollama running, and have you picked a model that's downloaded?";
  }
  return "Your brain didn't answer. Check the key and try again.";
}

// ── Chat send (loop 031) ─────────────────────────────────────────────────────────────
const CHAT_MAX_INPUT = 32 * 1024; // bound untrusted renderer text before it reaches a brain
const TOKEN_FLUSH_MS = 33; // coalesce tokens at ≈30fps so a fast stream can't churn the renderer
const TOKEN_FLUSH_BYTES = 4096; // …but flush sooner if a burst piles up (flood cap)

// One in-flight generation per chat; `chat:stop` aborts it by id.
const chatAborts = new Map<string, AbortController>();

// A plain transcript so the brain has conversation context. Capped to the tail so a long
// chat can't blow the prompt budget. ponytail: char cap; token-aware trim only if needed.
function buildChatPrompt(messages: ChatMessage[]): string {
  const MAX = 8000;
  const lines = messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
  const prompt = lines.join("\n") + "\nAssistant:";
  return prompt.length > MAX ? prompt.slice(prompt.length - MAX) : prompt;
}

// Append the user message, stream the reply through the router (tokens coalesced onto the
// one-way `chat:token` channel), then save the assistant reply (the partial, on stop).
// One receipt pair per message rides the router — chat adds no new egress path.
async function chatSend(chatId: string, text: string): Promise<ChatSendResult> {
  devlog(`send received — chat ${chatId}, ${text.length} chars`);
  if (!chatId || !text) return { ok: false, message: "Type a message first." };
  if (text.length > CHAT_MAX_INPUT) return { ok: false, message: "That message is a bit long — try shortening it." };
  const chat = getChat(chatId); // getChat throws only on an unsafe id; a bad id → null below
  if (!chat) return { ok: false, message: "That chat isn't here anymore." };
  const brain = loadBrain();
  // Self-reliant fallback: an unreachable Ollama brain falls back to a downloaded built-in.
  const { router, note: fallbackNote } = await routerWithSelfReliantFallback();
  if (!router) {
    devlog("no brain configured — refusing send");
    return { ok: false, message: "Connect a brain in Settings first, then try again." };
  }
  devlog(`brain = ${brain?.provider ?? "?"}${brain?.model ? `:${brain.model}` : ""}${fallbackNote ? " (falling back to built-in)" : ""}`);

  const now = new Date().toISOString();
  await appendMessage(chatId, { role: "user", content: text, ts: now });
  const prompt = buildChatPrompt(getChat(chatId)?.messages ?? []);
  devlog(`prompt built (${prompt.length} chars); starting generation…`);

  const messageId = randomUUID();
  const controller = new AbortController();
  // ponytail: one in-flight generation per chat — a second concurrent send to the same
  // chat would overwrite this controller (Stop would then only abort the newer). The UI's
  // `sending` guard already blocks that; per-send controllers only if a caller ever sends
  // concurrently to one chat.
  chatAborts.set(chatId, controller);

  let tokenCount = 0;
  const coalescer = createTokenCoalescer(
    (delta) => {
      tokenCount++;
      if (tokenCount === 1) devlog("first token received — streaming to the screen");
      sendChatToken(mainWindow, { chatId, messageId, delta });
    },
    { flushMs: TOKEN_FLUSH_MS, flushBytes: TOKEN_FLUSH_BYTES },
  );

  try {
    const res = await router.generateStream({ task: "Chat", prompt }, (d) => coalescer.push(d), controller.signal);
    coalescer.flush(); // any buffered tail before we finalize
    devlog(`done — ${res.text.length} chars, ${tokenCount} flushes`);
    // The partial (on stop) is a real answer — save it, never discard (contract C3).
    if (res.text.length > 0) {
      await appendMessage(chatId, { role: "assistant", content: res.text, ts: new Date().toISOString() });
    }
    // A reply with zero text isn't a crash, but it IS "nothing happened" to the user —
    // tell them honestly instead of leaving a blank bubble.
    if (res.text.length === 0) return { ok: false, messageId, message: "Your brain replied with nothing. Check it in Settings and try again." };
    return { ok: true, messageId, text: res.text, note: fallbackNote || undefined };
  } catch (err) {
    coalescer.flush();
    // The raw brain/network error stays in main (could carry a key/prompt) — warm copy
    // out to the user; the real reason is on the terminal (see withDevErrorLog) in dev.
    devlog("generation failed:", err instanceof Error ? scrubSecrets(err.message) : err);
    // Actionable, provider-aware hint (e.g. "Is Ollama running?") — same as "Test my brain".
    return { ok: false, messageId, message: brainFailureMessage() };
  } finally {
    chatAborts.delete(chatId);
  }
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
  disposeLocal(); // kill the embedded runtime child, if one is warm
});

app.on("window-all-closed", () => {
  // tray app: stay alive — unless there is no tray to reopen from
  if (tray === null) app.quit();
});

// Only one instance may run per user-data dir. A second launch would fight the first
// over its Chromium cache — the `disk_cache "Access is denied" / Unable to create cache`
// errors. Instead, the second instance quits and hands focus to the first. Keyed on the
// userData path, so Playwright e2e runs (each with its own --user-data-dir) are unaffected.
if (!app.requestSingleInstanceLock()) {
  quitting = true;
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app
  .whenReady()
  .then(() => {
    registerTrusted(TRUST, "app:info", () => getAppInfo());

    // First-party cloud calls are egress too. Each client gets a receipted `fetch`
    // wrapper (loop 015): a durable "sent" line lands before any byte leaves, so
    // the Receipts panel shows EVERY outbound byte — not just model + plugin calls.
    // Metadata only (host + label + bytes), never a key, token, or body.
    const fetchSink = fileFetchSink();

    const account = createAccountClient(API_BASE, receiptedFetch(fetchSink, "Deskhand: sign-in", { direction: "out" }));

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

    // News is read-only polling (no business data leaves) → routine: grouped in the panel.
    // You're pulling news in → direction "in".
    const news = createNewsClient(API_BASE, receiptedFetch(fetchSink, "Deskhand: news", { routine: true, direction: "in" }));
    registerTrusted(TRUST, "news:list", async (): Promise<NewsPostView[]> => {
      try {
        return await news.list();
      } catch {
        return [];
      }
    });

    // The unread-badge poll (thread/read) fires every 5s and carries no business
    // data → routine (grouped). A user's actual message (send) is real business data
    // leaving → its OWN non-routine client, so it can never hide in the quiet group.
    const dm = createDmClient(API_BASE, receiptedFetch(fetchSink, "Deskhand: messages", { routine: true, direction: "in" }));
    const dmSend = createDmClient(API_BASE, receiptedFetch(fetchSink, "Deskhand: your message to Dawid", { direction: "out" }));
    registerTrusted(TRUST, "dm:send", async (rawMessage: unknown): Promise<DmSendResult> => {
      const message = typeof rawMessage === "string" ? rawMessage : "";
      // The bearer token stays in main (keychain) — the renderer never holds it.
      const session = loadSession();
      if (!session) return { ok: false, message: "Please sign in first." };
      try {
        return await dmSend.send(session.token, message);
      } catch {
        return { ok: false, message: CANT_REACH };
      }
    });

    // Publish an AI Visibility result to a public link. The renderer passes only
    // the result; the session token stays in main (keychain). Outbound + opt-in:
    // only fires on the user's explicit Publish click.
    const publish = createPublishClient(API_BASE, receiptedFetch(fetchSink, "Deskhand: publish", { direction: "out" }));
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

    // Track founder replies across polls so a genuinely NEW one becomes a distinct "In"
    // Receipts entry, while the same old/read thread coming back every 5s does not. The
    // baseline is in-memory (see the contract's ponytail note): a reply that lands while
    // the app is CLOSED is seen in the thread on next open but isn't logged as a new entry.
    let dmNewness = initialNewness;
    const API_HOST = new URL(API_BASE).host; // API_BASE is a trusted constant, always valid
    registerTrusted(TRUST, "dm:thread", async (): Promise<DmThreadView> => {
      const session = loadSession();
      if (!session) return { messages: [], unread: 0 };
      let thread: DmThreadView;
      try {
        thread = await dm.thread(session.token);
      } catch {
        return { messages: [], unread: 0 };
      }
      // A genuinely-new founder reply → one distinct, non-routine "In" entry. NOT egress
      // (nothing left — this is inbound), so it's a single "done" record, not a fail-closed
      // "sent"+"done" pair. Metadata only: never the message body.
      const { state, newReplies } = observeThread(dmNewness, thread);
      dmNewness = state;
      if (newReplies > 0) {
        try {
          await fetchSink.append({
            kind: "fetch",
            host: API_HOST,
            task: newReplies === 1 ? "Deskhand: new reply from Dawid" : `Deskhand: ${newReplies} new replies from Dawid`,
            bytesSent: 0,
            bytesReceived: 0,
            direction: "in",
            ts: new Date().toISOString(),
            ok: true,
            phase: "done",
          });
        } catch {
          // best-effort UX entry; a failed append never denies the user their messages
        }
      }
      return thread;
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
    // No range → the recent window (fast, the mount load). A range → the full retained
    // history for those dates, spanning every archive, so a calendar click reaches rows
    // that aged out of the recent window. Read-only, no egress.
    registerTrusted(TRUST, "receipts:list", (raw: unknown): Promise<ReceiptView[]> => {
      const r = (raw ?? {}) as { from?: unknown; to?: unknown };
      const from = typeof r.from === "string" && r.from ? r.from : undefined;
      const to = typeof r.to === "string" && r.to ? r.to : undefined;
      return from || to ? readReceiptsInRange({ from, to }) : readReceipts();
    });

    // The activity calendar's data: the durable day→count index + the day the grid ends
    // on ("today"). Read-only, no egress.
    registerTrusted(
      TRUST,
      "receipts:activity",
      async (): Promise<ActivitySummary> => ({ counts: await readActivityIndex(), today: todayKey() }),
    );

    // Export selected receipts to a CSV the user keeps. Main sanitizes (formula-injection
    // safe) + serializes + writes to a user-chosen path (save dialog); a temp-path seam
    // bypasses the dialog in CI. Metadata only — the same non-secret fields the log holds,
    // never a key/body. A LOCAL file write, not network egress, so no egress receipt.
    // Returns the path written, or null if the user cancelled / nothing to export.
    registerTrusted(TRUST, "receipts:exportCsv", async (raw: unknown): Promise<string | null> => {
      const rows = Array.isArray(raw) ? (raw as ReceiptView[]) : [];
      // Trust-boundary guard: the UI can only select what it loaded (≤2000), so a payload
      // past that is a buggy/hostile caller — refuse rather than serialize an unbounded blob.
      if (rows.length === 0 || rows.length > 10_000) return null;
      const csv = toCsv(rows);
      let dest = EXPORT_PATH_OVERRIDE;
      if (!dest) {
        const res = await dialog.showSaveDialog({
          title: "Save your receipts",
          defaultPath: "deskhand-receipts.csv",
          filters: [{ name: "Spreadsheet (CSV)", extensions: ["csv"] }],
        });
        if (res.canceled || !res.filePath) return null;
        dest = res.filePath;
      }
      writeFileSync(dest, csv);
      return dest;
    });

    // Brain (model router). The key lives in the keychain (keys.ts) and never
    // leaves main; the renderer only picks a brain and sees the result + receipt.
    registerTrusted(TRUST, "brain:status", (): BrainStatusView => brainStatus());

    registerTrusted(TRUST, "brain:save", (raw: unknown): SaveBrainResult => {
      const input = (raw ?? {}) as { provider?: unknown; key?: unknown; model?: unknown };
      const provider: ProviderId =
        input.provider === "anthropic"
          ? "anthropic"
          : input.provider === "claude-cli"
            ? "claude-cli"
            : input.provider === "local"
              ? "local"
              : "openrouter";
      const key = typeof input.key === "string" ? input.key.trim() : "";
      const model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : undefined;
      // The local brain needs a chosen model but no key; the subscription brain has
      // neither; the API-key brains require a key.
      if (provider === "local" && !model) return { ok: false, message: "Pick a model to run on this computer first." };
      if (provider !== "claude-cli" && provider !== "local" && !key) return { ok: false, message: "Paste your key first." };
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
        // The subscription/local brains have no key — a failure means the CLI or
        // Ollama isn't there, so say that instead of "check the key".
        return { ok: false, message: brainFailureMessage() };
      }
    });

    // Local Brain (loop 019). The renderer NEVER touches Ollama or the network —
    // main runs the scan, the loopback Ollama, the receipted catalog fetch, and the
    // pull; the renderer only reads these views and drives them by IPC.
    registerTrusted(TRUST, "local:status", (): Promise<LocalStatusView> => localStatus());
    registerTrusted(TRUST, "local:rescan", (): Promise<LocalStatusView> => localStatus());
    registerTrusted(TRUST, "local:models", (): Promise<LocalModelsView> => localModels());

    // Start a pull; progress streams back on `local:pullProgress` (reuse the 016
    // main→renderer channel). We forward derived, pre-validated fields only.
    registerTrusted(TRUST, "local:pull", async (rawId: unknown): Promise<LocalActionResult> => {
      const modelId = typeof rawId === "string" ? rawId.trim() : "";
      // Ollama model ids are short tags — cap so a bad renderer can't send a blob.
      if (!modelId || modelId.length > 200) return { ok: false, message: "That model name doesn't look right." };
      const send = (view: PullProgressView): void => mainWindow?.webContents.send("local:pullProgress", view);
      try {
        await pullModel(modelId, (p: PullProgress) => {
          send({ modelId, percent: p.percent ?? 0, status: p.status, done: false, ok: true });
        });
        send({ modelId, percent: 100, status: "done", done: true, ok: true });
        return { ok: true, message: "Downloaded — it's ready to use." };
      } catch (err) {
        // The engine's message is already plain-language + safe (no key/prompt).
        const message = err instanceof Error ? err.message : "The download didn't finish. Try again.";
        send({ modelId, percent: 0, status: message, done: true, ok: false });
        return { ok: false, message };
      }
    });

    // Chat (loop 031). Main-owned per-chat storage + streaming replies through the
    // SAME router (so receipts + local/cloud honesty are inherited, not re-implemented).
    // The renderer never touches disk or the brain — it drives these by IPC and listens
    // for tokens on the one-way `chat:token` channel.
    registerTrusted(TRUST, "chat:list", (): ChatMeta[] => listChats());
    registerTrusted(TRUST, "chat:get", (rawId: unknown): ChatView | null => {
      const id = typeof rawId === "string" ? rawId : "";
      try {
        return getChat(id);
      } catch {
        return null; // an unsafe id is "no such chat", never a throw across IPC
      }
    });
    registerTrusted(TRUST, "chat:new", (): Promise<ChatMeta> => newChat());
    registerTrusted(TRUST, "chat:rename", (rawId: unknown, rawTitle: unknown): Promise<void> => {
      const id = typeof rawId === "string" ? rawId : "";
      const title = typeof rawTitle === "string" ? rawTitle : "";
      return renameChat(id, title);
    });
    registerTrusted(TRUST, "chat:delete", (rawId: unknown): Promise<void> => {
      const id = typeof rawId === "string" ? rawId : "";
      return deleteChat(id);
    });
    // Stop an in-flight generation for this chat — the router treats an abort as a
    // legitimate partial (not a failure), so the partial reply is still saved.
    registerTrusted(TRUST, "chat:stop", (rawId: unknown): void => {
      const id = typeof rawId === "string" ? rawId : "";
      chatAborts.get(id)?.abort();
    });
    registerTrusted(TRUST, "chat:send", (raw: unknown): Promise<ChatSendResult> => {
      const o = (raw ?? {}) as { chatId?: unknown; text?: unknown };
      const chatId = typeof o.chatId === "string" ? o.chatId : "";
      const text = typeof o.text === "string" ? o.text.trim() : "";
      return chatSend(chatId, text);
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

    // Reclaim disk from interrupted downloads (crashes, the old unique-name scheme),
    // keeping any `.part` that resume can still finish. Best-effort, non-blocking.
    // ponytail: the keep-set is seeded from the bundled snapshot (pre live-catalog fetch),
    // so a partial of a live-catalog-ONLY model gets swept → re-downloads from scratch.
    // Wasteful, never corrupt; the snapshot is the shipped baseline. Widen to the live
    // catalog here if snapshot/live gguf filenames ever diverge meaningfully.
    void sweepOrphanParts(embeddedFilenames());

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
