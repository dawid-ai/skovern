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
} from "@skovern/core";
import { explainCapability } from "@skovern/plugin-sdk";
import { registerTrusted } from "./ipc.js";
import { clearSession, loadSession, saveSession } from "./session.js";
import { brainStatus, loadBrain, saveBrain } from "./keys.js";
import { fileFetchSink, fileReceiptSink, readActivityIndex, readReceipts, readReceiptsInRange, receiptedFetch } from "./receipts.js";
import { toCsv } from "./csv.js";
import { runPlugin, sandboxCheck } from "./plugin-host.js";
import { claudeCliProvider } from "./claude-cli.js";
import { brainSwitchPlan } from "./brain-switch.js";
import { classifyAddress, connectProbe, deleteLocalModel, disposeLocal, downloadedEmbeddedModelId, downloadedModelsView, embeddedFilenameFor, embeddedFilenames, engineForModel, freeMemory, freeOutgoingBrain, isEmbeddedModel, localModels, localStatus, makeEngine, modelLoaded, openModelsFolder, pullModel } from "./local.js";
import { normalizeEndpoint } from "./connect-endpoint.js";
import { appendMessage, createTokenCoalescer, deleteChat, getChat, listChats, newChat, renameChat, sendChatStatus, sendChatToken } from "./chat-store.js";
import { resolveChatReply } from "./chat-reply.js";
import { validateOllamaName } from "./ollama-name.js";
import { disposeOllama, ensureOllamaRunning, fakeLaunchCount, ollamaInstalled, pickOllamaAction, sweepOrphanedOllama } from "./ollama-launch.js";
import { getSettings, setOllamaLaunch, type OllamaLaunch } from "./settings-store.js";
import { sweepOrphanParts } from "./download.js";
import { initialNewness, observeThread } from "./dm-newness.js";
import { helloManifest } from "../plugins/hello/manifest.js";
import { aiVisibilityManifest } from "../plugins/ai-visibility/manifest.js";
import type { CurrentAccount, RequestResult, VerifyResult } from "../shared/account.js";
import type { DmSendResult, DmThreadView, NewsPostView, PublishResultView } from "../shared/cloud.js";
import type { BrainStatusView, SaveBrainResult, TestBrainResult } from "../shared/brain.js";
import type { ConnectProbeView, LocalActionResult, LocalModelsView, LocalStatusView, PullProgressView, YourModelsView } from "../shared/local.js";
import type { RunSkillResult, SandboxCheckResult, SkillView } from "../shared/plugin.js";
import type { ActivitySummary, ReceiptView } from "../shared/receipts.js";
import type { ChatMessage, ChatMeta, ChatSendResult, ChatView } from "../shared/chat.js";
import type { OllamaStatusView, SettingsView } from "../shared/settings.js";

// Product identity. Set the app name BEFORE any userData path is resolved, so both packaged
// and dev data live under a "Skovern" folder.
app.setName("Skovern");

const { autoUpdater } = electronUpdater;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dev server URL is only ever honored in unpackaged (dev) builds
const DEV_SERVER_URL = app.isPackaged ? undefined : process.env["ELECTRON_RENDERER_URL"];
const RENDERER_INDEX_PATH = path.join(__dirname, "../renderer/index.html");
const RENDERER_INDEX_URL = pathToFileURL(RENDERER_INDEX_PATH).href;
const TRUST = { devServerUrl: DEV_SERVER_URL, rendererIndexUrl: RENDERER_INDEX_URL };

// The core auth client is the ONLY thing that talks to the cloud API. Local
// server by default; a hosted URL is injected via env when one exists.
const API_BASE = process.env["SKOVERN_API_URL"] ?? "http://127.0.0.1:8787";

// Receipts calendar "today" and CSV export path — dev/test seams (mirror of
// DEV_SERVER_URL), honored ONLY unpackaged so the e2e day-grid is fixed on any runner
// and the export asserts file content without the OS save dialog. Production uses the
// real clock and the real dialog.
const NOW_OVERRIDE = (!app.isPackaged && process.env["SKOVERN_NOW"]) || undefined;
const EXPORT_PATH_OVERRIDE = (!app.isPackaged && process.env["SKOVERN_EXPORT_PATH"]) || undefined;
function todayKey(): string {
  const base = NOW_OVERRIDE ? new Date(NOW_OVERRIDE) : new Date();
  const when = Number.isNaN(base.getTime()) ? new Date() : base;
  return when.toISOString().slice(0, 10); // YYYY-MM-DD (UTC), matches the index's day keys
}

// Brain base-URL overrides are a dev/test seam (point the real adapter at a mock).
// Honored ONLY in unpackaged builds — a shipped app must never let an env var
// redirect the user's key + prompt to an arbitrary host (mirror of DEV_SERVER_URL).
const BRAIN_BASE = {
  openrouter: app.isPackaged ? undefined : process.env["SKOVERN_OPENROUTER_BASE_URL"],
  anthropic: app.isPackaged ? undefined : process.env["SKOVERN_ANTHROPIC_BASE_URL"],
};
// The Claude Code CLI brain. In a shipped app it's always the real `claude` on PATH;
// the bin/args overrides are dev/test seams (point at a stub so CI needs no
// subscription) honored ONLY unpackaged — mirror of BRAIN_BASE. A packaged app must
// never let an env var redirect the user's prompt to an arbitrary executable.
const CLAUDE_BIN = (!app.isPackaged && process.env["SKOVERN_CLAUDE_BIN"]) || "claude";
function devClaudeArgs(): string[] | undefined {
  if (app.isPackaged) return undefined;
  const raw = process.env["SKOVERN_CLAUDE_ARGS"];
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
const PLUGIN_ALLOW_LOOPBACK = !app.isPackaged && process.env["SKOVERN_PLUGIN_ALLOW_LOOPBACK"] === "1";
const HELLO_URL = (!app.isPackaged && process.env["SKOVERN_HELLO_URL"]) || "https://example.com";

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
      ? // A local model has no model id → no brain to run; guard with a clear id. The dispatcher
        // picks the embedded runtime for a gguf model, a connected remote if the brain carries an
        // endpoint (loop 044), else the loopback Ollama.
        localProvider(engineForModel(brain.model ?? "", brain.endpoint), brain.model ?? "")
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
// `onStatus` (loop 033 Issue 4) reports launch/prepare phases so the UI can show what's
// happening instead of looking hung; `needsSetup` (Issue 1/3) is true when the user has no
// runnable brain and setting one up would fix it (Ollama down + no built-in to fall back to).
async function routerWithSelfReliantFallback(
  onStatus?: (phase: string) => void,
): Promise<{ router: Router | null; note: string; needsSetup: boolean }> {
  const brain = loadBrain();
  const normal = buildRouter();
  if (!brain) {
    devlog("resolve: no brain configured");
    return { router: normal, note: "", needsSetup: false };
  }
  // Cloud/CLI brains and already-embedded local brains never touch Ollama.
  if (brain.provider !== "local") {
    devlog(`resolve: ENGINE = ${brain.provider.toUpperCase()} (cloud/CLI) "${brain.model ?? "default"}" — no local runtime`);
    return { router: normal, note: "", needsSetup: false };
  }
  if (isEmbeddedModel(brain.model ?? "")) {
    devlog(`resolve: ENGINE = EMBEDDED built-in "${brain.model}" (node-llama-cpp on this computer) — Ollama not involved`);
    return { router: normal, note: "", needsSetup: false };
  }
  // A CONNECTED brain (loop 044) runs on its own endpoint, NOT loopback Ollama — so the loopback
  // probe + built-in fallback below must not hijack it (it would find loopback unreachable and swap
  // to embedded, ignoring the endpoint the user connected to).
  if (brain.endpoint) {
    devlog(`resolve: ENGINE = CONNECTED "${brain.model}" @ ${brain.endpoint} — normal router, no loopback fallback`);
    return { router: normal, note: "", needsSetup: false };
  }
  // A local Ollama brain: probe whether Ollama is actually reachable.
  devlog(`resolve: local OLLAMA brain "${brain.model}" — probing Ollama (GET /api/tags)…`);
  const t0 = Date.now();
  const running = await makeEngine().detect();
  devlog(`  ↳ probe: ${running ? "REACHABLE" : "UNREACHABLE"} in ${Date.now() - t0}ms`);
  const pref = getSettings().ollamaLaunch;
  const inst = ollamaInstalled();
  const action = pickOllamaAction(inst, running, pref);
  devlog(`  ↳ decision: ${action}  (installed=${inst}, running=${running}, launchPref=${pref})`);
  if (action === "use-ollama") {
    devlog(`  ↳ ENGINE = OLLAMA "${brain.model}" (Ollama's own runtime — usually GPU-accelerated)`);
    return { router: normal, note: "", needsSetup: false };
  }
  if (action === "launch-then-use") {
    devlog("  ↳ launching Ollama (spawn `ollama serve`) + waiting for readiness…");
    onStatus?.("Starting Ollama…");
    const tl = Date.now();
    if (await ensureOllamaRunning(() => makeEngine().detect())) {
      devlog(`  ↳ Ollama came up in ${Date.now() - tl}ms → ENGINE = OLLAMA "${brain.model}"`);
      return { router: normal, note: "", needsSetup: false };
    }
    devlog(`  ↳ Ollama did NOT come up after ${Date.now() - tl}ms → falling back to built-in`);
  }
  // use-builtin (or a launch that didn't come up): fall back to a downloaded built-in model.
  const fallbackId = downloadedEmbeddedModelId();
  if (!fallbackId) {
    devlog("  ↳ no built-in model on disk → send will fail honestly + offer setup");
    return { router: normal, note: "", needsSetup: true };
  }
  // THIS is the slow path Dawid is chasing: Ollama isn't reachable, so chat runs the built-in
  // node-llama-cpp model instead — typically much slower than Ollama (different runtime,
  // possibly CPU-bound / a heavier quant). The log makes that switch visible.
  devlog(`  ↳ ⚠ FALLBACK → ENGINE = EMBEDDED "${fallbackId}" (node-llama-cpp) because Ollama is UNREACHABLE. This is usually SLOWER than Ollama — start Ollama to use "${brain.model}" instead.`);
  onStatus?.("Loading your built-in brain…");
  return {
    router: buildLocalEmbeddedRouter(fallbackId),
    note: "Your usual brain wasn't available, so I used your built-in one on this computer.",
    needsSetup: false,
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
// Shown when a reply streamed then stopped early (the model hit its context limit) — florist copy.
const CHAT_CUTOFF_NOTE = "That answer got cut off — the brain ran out of room. Try asking for a shorter reply.";
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
  const sendStatus = (phase: string): void => sendChatStatus(mainWindow, { chatId, phase });
  // Self-reliant fallback: an unreachable Ollama brain falls back to a downloaded built-in,
  // reporting launch/prepare phases so the wait never looks hung (Issue 4).
  const tResolve = Date.now();
  const { router, note: fallbackNote, needsSetup } = await routerWithSelfReliantFallback(sendStatus);
  devlog(`brain resolved in ${Date.now() - tResolve}ms`);
  if (!router) {
    devlog("no brain configured — refusing send");
    return { ok: false, message: "Connect a brain in Settings first, then try again.", offerSetup: true };
  }

  const now = new Date().toISOString();
  await appendMessage(chatId, { role: "user", content: text, ts: now });
  const prompt = buildChatPrompt(getChat(chatId)?.messages ?? []);
  devlog(`prompt built (${prompt.length} chars, ${getChat(chatId)?.messages.length ?? 0} msgs of history); starting generation…`);

  const messageId = randomUUID();
  const controller = new AbortController();
  // ponytail: one in-flight generation per chat — a second concurrent send to the same
  // chat would overwrite this controller (Stop would then only abort the newer). The UI's
  // `sending` guard already blocks that; per-send controllers only if a caller ever sends
  // concurrently to one chat.
  chatAborts.set(chatId, controller);

  let tokenCount = 0;
  // Accumulate every streamed delta here, independent of what the engine returns. If the
  // generation ERRORS mid-stream (e.g. the model fills its context window) or ends empty,
  // the tokens already on the user's screen are a real, partial answer — we save THIS so the
  // reply is never dropped to a blank turn (Issue 6).
  let streamed = "";
  const tGen = Date.now(); // generation clock: measure time-to-first-token + total
  let tFirst = 0;
  const coalescer = createTokenCoalescer(
    (delta) => {
      tokenCount++;
      if (tokenCount === 1) {
        tFirst = Date.now();
        devlog(`first token after ${tFirst - tGen}ms — streaming to the screen`);
        sendStatus(""); // the reply is arriving → clear the "preparing" indicator
      }
      sendChatToken(mainWindow, { chatId, messageId, delta });
    },
    { flushMs: TOKEN_FLUSH_MS, flushBytes: TOKEN_FLUSH_BYTES },
  );

  // Keep a "preparing" status on screen until the first token (Issue 4): a big embedded model
  // takes seconds to load and a cold Ollama call has connect latency — either way the user
  // sees progress, not a frozen screen. The fallback path already sent its own phase.
  const embedded = brain?.provider === "local" && isEmbeddedModel(brain.model ?? "");
  // "Working on it…" (not "Thinking…") so it's never mistaken for a reasoning-model trace — it's
  // just the pre-first-token wait (a cold model load can take several seconds).
  sendStatus(fallbackNote ? "Loading your built-in brain…" : embedded ? "Loading the model…" : "Working on it…");

  try {
    const res = await router.generateStream({ task: "Chat", prompt }, (d) => { streamed += d; coalescer.push(d); }, controller.signal);
    coalescer.flush(); // any buffered tail before we finalize
    // The telemetry that answers "what actually ran + why slow": the REAL model the router
    // used (res.model — Ollama's id, or the embedded fallback's), time-to-first-token, total
    // time, output tokens, and derived tokens/sec. `res.provider:res.model` is authoritative.
    const genMs = Date.now() - tGen;
    const outTok = res.receipt.tokensOut;
    const firstMs = tFirst > 0 ? tFirst - tGen : genMs;
    const tps = outTok && genMs > 0 ? (outTok / (genMs / 1000)).toFixed(1) : "?";
    devlog(
      `done: engine=${res.provider}:${res.model}  first-token=${firstMs}ms  total=${genMs}ms  ` +
        `out=${outTok ?? "?"} tokens  ~${tps} tok/s  (${res.text.length} chars, ${tokenCount} render-flushes)`,
    );
    // The partial (on Stop) is a real answer — save it, never discard (contract C3).
    const d = resolveChatReply({ resText: res.text, streamed, errored: false });
    if (d.save !== null) {
      await appendMessage(chatId, { role: "assistant", content: d.save, ts: new Date().toISOString() });
      return { ok: true, messageId, text: d.save, note: fallbackNote || undefined };
    }
    // Truly nothing came back (no text, no streamed tokens) — not a crash, but "nothing
    // happened" to the user, so say so honestly instead of leaving a blank bubble.
    return { ok: false, messageId, message: "Your brain replied with nothing. Check it in Settings and try again." };
  } catch (err) {
    coalescer.flush();
    // The raw brain/network error stays in main (could carry a key/prompt) — warm copy
    // out to the user; the real reason is on the terminal (see withDevErrorLog) in dev.
    devlog("generation failed:", err instanceof Error ? scrubSecrets(err.message) : err);
    // Issue 6: if the model already streamed text before it failed (it filled its context
    // window and choked), that text is a real partial answer — KEEP it and say it was cut
    // off, never drop it to a blank turn. Only a failure with zero streamed text is a bare error.
    const d = resolveChatReply({ resText: "", streamed, errored: true });
    if (d.save !== null) {
      await appendMessage(chatId, { role: "assistant", content: d.save, ts: new Date().toISOString() });
      return { ok: true, messageId, text: d.save, note: CHAT_CUTOFF_NOTE };
    }
    // Actionable, provider-aware hint (e.g. "Is Ollama running?") — same as "Test my brain".
    // If the failure is "no usable brain + no built-in to fall back to", also offer setup.
    return { ok: false, messageId, message: brainFailureMessage(), offerSetup: needsSetup };
  } finally {
    sendStatus(""); // clear any lingering "preparing" status, whatever the outcome
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
    title: "Skovern",
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

  // closing the window keeps Skovern in the tray — but only if the tray exists.
  // The brain STAYS LOADED across a hide-to-tray: a background job may still be using it,
  // and this is global lifecycle that future plugins inherit. The 5-min idle-unload
  // (embedded) / Ollama's own keep-alive frees an unused model instead; a real close
  // (app quit, below) still disposes it. Do NOT reap the brain here.
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
  tray.setToolTip("Skovern");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Skovern",
        click: () => {
          mainWindow?.show();
          mainWindow?.focus();
        },
      },
      { type: "separator" },
      {
        label: "Quit Skovern",
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
  disposeOllama(); // kill an Ollama we started (never one the user was already running)
});

// A terminal Ctrl+C (dev) or a SIGTERM skips `before-quit`, so our managed children — and,
// worse, the Ollama runner processes holding VRAM — would leak. Reap them, then exit. (A hard
// SIGKILL / Task-Manager kill can't be trapped; the startup reaper below covers that case.)
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    disposeLocal();
    disposeOllama();
    process.exit(0);
  });
}

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

    const account = createAccountClient(API_BASE, receiptedFetch(fetchSink, "Skovern: sign-in", { direction: "out" }));

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
    const news = createNewsClient(API_BASE, receiptedFetch(fetchSink, "Skovern: news", { routine: true, direction: "in" }));
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
    const dm = createDmClient(API_BASE, receiptedFetch(fetchSink, "Skovern: messages", { routine: true, direction: "in" }));
    const dmSend = createDmClient(API_BASE, receiptedFetch(fetchSink, "Skovern: your message to Dawid", { direction: "out" }));
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
    const publish = createPublishClient(API_BASE, receiptedFetch(fetchSink, "Skovern: publish", { direction: "out" }));
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
            task: newReplies === 1 ? "Skovern: new reply from Dawid" : `Skovern: ${newReplies} new replies from Dawid`,
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
          defaultPath: "skovern-receipts.csv",
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
    registerTrusted(
      TRUST,
      "brain:status",
      async (): Promise<BrainStatusView> => {
        const base = brainStatus();
        return {
          ...base,
          // Renderer-facing self-reliance signals (loop 033): is the built-in floor real (a
          // model on disk), and is the optional Ollama helper present? Both computed here so
          // keys.ts stays purely about the keychain.
          builtinReady: downloadedEmbeddedModelId() !== null,
          ollamaInstalled: ollamaInstalled(),
          // Green-vs-gray chip (loop 034): only a LOCAL brain has a resident/unloaded
          // distinction — an online brain is neither loaded nor unloaded here.
          modelLoaded: base.provider === "local" ? await modelLoaded(base.model) : false,
        };
      },
    );

    registerTrusted(TRUST, "brain:save", async (raw: unknown): Promise<SaveBrainResult> => {
      const input = (raw ?? {}) as { provider?: unknown; key?: unknown; model?: unknown; endpoint?: unknown };
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
      // A connect-by-address local brain (loop 044) carries an endpoint. Re-validate it at the
      // trust boundary (never trust the renderer's copy) — a bad address is rejected before save.
      let endpoint: string | undefined;
      if (provider === "local" && typeof input.endpoint === "string" && input.endpoint.trim()) {
        const normalized = normalizeEndpoint(input.endpoint);
        if (!normalized) return { ok: false, message: "That address doesn't look right — try like 192.168.1.5:11434." };
        endpoint = normalized;
      }
      // The local brain needs a chosen model but no key; the subscription brain has
      // neither; the API-key brains require a key.
      if (provider === "local" && !model) return { ok: false, message: "Pick a model to run on this computer first." };
      if (provider !== "claude-cli" && provider !== "local" && !key) return { ok: false, message: "Paste your key first." };
      // No real API key is this long — cap it so a bad/compromised renderer can't
      // write a multi-MB blob into the keychain file.
      if (key.length > 8192) return { ok: false, message: "That doesn't look like a key." };
      const prev = loadBrain();
      const filename = provider === "local" && model && !endpoint ? embeddedFilenameFor(model) : undefined;
      try {
        saveBrain({ provider, key, model, endpoint, ...(filename ? { filename } : {}) });
      } catch {
        // safeStorage unavailable — we refuse to write a key in plaintext
        return { ok: false, message: "Couldn't store the key safely on this computer." };
      }
      // Loop 045 B1: free the outgoing brain's memory so it doesn't stay resident next to the new
      // one. Runs only AFTER a valid save (a rejected save unloads nothing), and before we return,
      // so nothing loads the new model first. Best-effort — an unload failure never fails the save.
      try {
        await freeOutgoingBrain(brainSwitchPlan(prev, { provider, model, endpoint }, isEmbeddedModel));
      } catch {
        /* best-effort */
      }
      return { ok: true, message: "Brain saved." };
    });

    // Connect-by-address (loop 044): probe a typed address — reachable? off-box? which models? —
    // BEFORE saving a brain, so the UI can show the right ceremony (localhost light-confirm vs
    // off-box egress-warning) and the model list. For an off-box address this makes the first
    // off-box call, which is receipted (connectProbe → connectedEngine). Never throws across IPC.
    registerTrusted(TRUST, "local:connect", (raw: unknown): Promise<ConnectProbeView> => {
      const address = typeof raw === "string" ? raw : "";
      return connectProbe(address);
    });

    // Classify a typed address WITHOUT any network call, so the UI can show the off-box egress
    // warning BEFORE it probes (which is the first byte off-box). Pure — no fetch here.
    registerTrusted(TRUST, "local:classify", (raw: unknown): { valid: boolean; offBox: boolean; endpoint: string | null } => {
      return classifyAddress(typeof raw === "string" ? raw : "");
    });

    registerTrusted(TRUST, "brain:test", async (): Promise<TestBrainResult> => {
      // Self-reliant: an unreachable Ollama brain falls back to the built-in one, same as chat.
      const { router, note } = await routerWithSelfReliantFallback();
      if (!router) return { ok: false, message: "Add a brain first, then test it." };
      try {
        const { text, receipt } = await router.generate({
          task: "Test my brain",
          prompt: "Say a short, friendly hello so I know you're working.",
        });
        return { ok: true, message: note ? `Your brain answered! (${note})` : "Your brain answered!", reply: text, receipt };
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
      // Validate the name (untrusted free text from pull-by-name) to a safe Ollama-name shape
      // BEFORE any /api/pull — a specific reason, not a bare "doesn't look right". Embedded
      // catalog ids (qwen2.5:3b) pass this too.
      const v = validateOllamaName(typeof rawId === "string" ? rawId : "");
      if (!v.ok) return { ok: false, message: v.reason };
      const modelId = v.name;
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

    // "Your models" (loop 041): see what's downloaded + loaded, delete to reclaim disk, free
    // memory to reclaim VRAM. All main-owned; the renderer only reads/drives by IPC.
    registerTrusted(TRUST, "local:downloadedModels", (): Promise<YourModelsView> => downloadedModelsView());
    registerTrusted(TRUST, "local:freeMemory", (): Promise<{ freed: boolean }> => freeMemory());
    // Open the folder where OUR downloaded brains live (userData/models) — a fixed app-owned path,
    // no renderer input (BUG C: so the user sees where their models are, vs Ollama's separate store).
    registerTrusted(TRUST, "local:revealModels", (): Promise<void> => openModelsFolder());
    registerTrusted(TRUST, "local:deleteModel", async (rawFile: unknown): Promise<LocalActionResult> => {
      const filename = typeof rawFile === "string" ? rawFile : "";
      try {
        return await deleteLocalModel(filename);
      } catch (err) {
        // deleteLocalModel throws (via modelPath) on a traversing/bad name BEFORE any unlink —
        // surface the safe plain-language reason, never delete outside the models dir.
        return { ok: false, message: err instanceof Error ? err.message : "That model couldn't be deleted." };
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

    // App settings (no secrets) + Ollama status. Ollama is an optional upgrade: the app
    // may auto-start it only when the user opts in (`ollamaLaunch: "always"`).
    registerTrusted(TRUST, "settings:get", (): SettingsView => getSettings());
    registerTrusted(TRUST, "settings:setOllamaLaunch", (raw: unknown): SettingsView => {
      const v = raw === "always" || raw === "never" || raw === "ask" ? (raw as OllamaLaunch) : "ask";
      setOllamaLaunch(v);
      return getSettings();
    });
    registerTrusted(TRUST, "ollama:status", async (): Promise<OllamaStatusView> => ({
      installed: ollamaInstalled(),
      running: await makeEngine().detect(),
      // Only surfaced under the unpackaged fake-spawn seam, so an e2e can prove a launch fired.
      ...(!app.isPackaged && process.env["SKOVERN_OLLAMA_SPAWN_FAKE"] === "1" ? { launchAttempts: fakeLaunchCount() } : {}),
    }));

    // Start Ollama once, on the user's explicit request (the in-chat "Start Ollama" CTA is the
    // consent — loop 033 Issue 1). Ephemeral: it does NOT change the persisted `ollamaLaunch`
    // pref. Only starts it if it's actually installed; returns whether it came up. Shell-free
    // spawn + readiness poll live in ensureOllamaRunning (same path as auto-launch).
    registerTrusted(TRUST, "ollama:start", async (): Promise<{ running: boolean }> => {
      if (!ollamaInstalled()) return { running: false };
      return { running: await ensureOllamaRunning(() => makeEngine().detect()) };
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
        // Self-reliant: skills also fall back to the built-in brain when Ollama is down.
        const { router } = await routerWithSelfReliantFallback();
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

    // Reap an `ollama serve` WE spawned that a previous hard-kill orphaned — it's still holding
    // VRAM and would starve a fresh model onto the CPU. Verified by pid + image before killing.
    sweepOrphanedOllama();

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
