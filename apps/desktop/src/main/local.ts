import { app, shell } from "electron";
import {
  ollamaEngine,
  ollamaResidentModels,
  ollamaUnload,
  verdict,
  type CatalogModel,
  type HardwareProfile,
  type LocalEngine,
  type LocalModelInfo,
  type PullProgress,
} from "@skovern/core";
import { allCandidates, builtInCandidates } from "./guided-verdict.js";
import { fileFetchSink } from "./receipts.js";
import { scanHardware } from "./hardware.js";
import { createCachedCatalogLoader, snapshotCatalog } from "./catalog.js";
import { modelDownloaded, listDownloadedModels, deleteDownloadedModel, modelsDir } from "./download.js";
import { modelDeletionPlan } from "./model-manage.js";
import { loadBrain, clearBrain } from "./keys.js";
import { ollamaInstalled } from "./ollama-launch.js";
import { llamaEngine, type ChildLike, type EmbeddedModel, type FromChild, type LlamaEngine } from "./llama-engine.js";
import type {
  HardwareView,
  LocalActionResult,
  LocalModelsView,
  LocalModelView,
  LocalStatusView,
  YourModelsView,
} from "../shared/local.js";

// The Local Brain service (TRUSTED main only): it wires the hardware scan, the
// Ollama engine (loopback), the live catalog, and the pure verdict into the plain
// views the renderer reads. The renderer makes NO network calls — everything
// on-machine or over-the-wire happens here, and the catalog fetch is receipted.

const GB = 1024 * 1024 * 1024;

// One shared catalog loader for both `localStatus` and `localModels`, so a single
// view-open (which calls both) makes ONE github fetch and writes ONE "model list"
// receipt instead of two. (Closes the `local-catalog-double-fetch` ledger item.)
const loadCatalog = createCachedCatalogLoader();

// Default to loopback Ollama. An override is a dev/test seam (point at a fixture),
// honored ONLY unpackaged — mirror of DEV_SERVER_URL. The engine ALSO enforces
// loopback regardless, so this can never reach off-box even if misused.
export function ollamaBaseUrl(): string {
  const override = !app.isPackaged ? process.env["SKOVERN_OLLAMA_URL"] : undefined;
  return override && override.length > 0 ? override : "http://127.0.0.1:11434";
}

// Catalog URL override is likewise an unpackaged dev/test seam (fixture server).
function catalogUrl(): string | undefined {
  return !app.isPackaged ? process.env["SKOVERN_CATALOG_URL"] || undefined : undefined;
}

// Hardware override: an unpackaged dev/test seam (mirror of the URL seams) that pins
// a HardwareProfile so the verdict is deterministic on any runner (CI is CPU-only, a
// dev box may have a big GPU). Inert when packaged — production always scans the real
// machine. A malformed override falls back to a real scan, never a crash.
async function scanProfile(): Promise<HardwareProfile> {
  const override = !app.isPackaged ? process.env["SKOVERN_HARDWARE"] : undefined;
  if (override) {
    try {
      return JSON.parse(override) as HardwareProfile;
    } catch {
      // malformed → fall through to a real scan
    }
  }
  return scanHardware();
}

export function makeEngine(): LocalEngine {
  return ollamaEngine({ baseUrl: ollamaBaseUrl() });
}

// The embedded runtime. `latestEmbedded` is the current set of catalog models that carry
// a `gguf` block (runnable without Ollama). It's seeded from the bundled snapshot and
// refreshed whenever a view loads the live/fixture catalog — so a pull/generate uses the
// SAME gguf (url/sha256/filename) the user saw, and the set is never empty.
function embeddedFrom(catalog: CatalogModel[]): EmbeddedModel[] {
  const out: EmbeddedModel[] = [];
  for (const m of catalog) if (m.gguf) out.push({ id: m.id, label: m.label, gguf: m.gguf });
  return out;
}
// Seeded from the snapshot so a pre-view call (a saved local brain at startup) resolves;
// then set to whatever the loaded catalog actually carries — INCLUDING empty, so a
// catalog with no gguf models correctly has zero embedded models (never a stale seed).
let latestEmbedded: EmbeddedModel[] = embeddedFrom(snapshotCatalog());
function rememberEmbedded(catalog: CatalogModel[]): void {
  latestEmbedded = embeddedFrom(catalog);
}
function hasEmbedded(): boolean {
  return latestEmbedded.length > 0;
}

/** The gguf filenames of the currently-known embedded models — the set the startup
 *  orphan sweep must KEEP (their `.part` is resumable). Seeded from the snapshot. */
export function embeddedFilenames(): string[] {
  return latestEmbedded.map((m) => m.gguf.filename);
}

/** The id of a downloaded, ready-to-run embedded model (the built-in, no-Ollama brain),
 *  preferring the largest by size, or null if none is on disk yet. The self-reliant
 *  fallback target: when the configured Ollama brain is unreachable, this can answer with
 *  zero external tools. */
export function downloadedEmbeddedModelId(): string | null {
  const ready = latestEmbedded.filter((m) => modelDownloaded(m.gguf.filename));
  if (ready.length === 0) return null;
  ready.sort((a, b) => b.gguf.sizeBytes - a.gguf.sizeBytes); // biggest downloaded = best
  return ready[0]!.id;
}

// A dev/test seam (unpackaged only, mirror of SKOVERN_OLLAMA_URL / SKOVERN_CLAUDE_BIN):
// when set, the embedded engine uses a FAKE in-process child that answers with canned
// text — so the app e2e can drive the real UI + real downloader without the native
// runtime. Inert (undefined) in a packaged app, which always forks the real child.
const FAKE_REPLY = "Hello — I'm your private brain, running right here on your computer.";

// The per-word gap the fake streams at. A dev/test seam (unpackaged only) so the chat
// e2e can slow the stream enough to deterministically observe a mid-stream partial.
function fakeStreamDelayMs(): number {
  const raw = !app.isPackaged ? process.env["SKOVERN_LLAMA_FAKE_DELAY_MS"] : undefined;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

function fakeLlamaSpawn(): (() => ChildLike) | undefined {
  if (app.isPackaged || process.env["SKOVERN_LLAMA_FAKE"] !== "1") return undefined;
  const delayMs = fakeStreamDelayMs();
  return () => {
    const listeners: { message: ((m: FromChild) => void)[] } = { message: [] };
    const emit = (m: FromChild): void => queueMicrotask(() => listeners.message.forEach((cb) => cb(m)));
    // Per-request stream state so an `abort` can stop mid-reply and finalize the partial.
    const streams = new Map<number, { timer: ReturnType<typeof setTimeout>; sent: string }>();
    emit({ type: "ready" });
    return {
      // Stream the canned reply word-by-word (a small gap between words) so the renderer
      // paints incremental partials — the e2e proves a mid-stream partial before the
      // final. The plain (non-streaming) `generate` path ignores `chunk`s and resolves
      // on the terminal `result`, whose text is the full reply (backward-compatible).
      send: (msg) => {
        if (msg.type === "abort") {
          const s = streams.get(msg.id);
          if (!s) return;
          clearTimeout(s.timer);
          streams.delete(msg.id);
          emit({ type: "result", id: msg.id, text: s.sent, tokensIn: 12, tokensOut: s.sent.split(" ").length });
          return;
        }
        const words = FAKE_REPLY.split(" ");
        // Test seam: stream a few words then ERROR mid-generation (simulates the model filling
        // its context window) — proves the streamed partial is kept, never dropped (Issue 6).
        const errorAfter = !app.isPackaged && process.env["SKOVERN_LLAMA_FAKE_ERROR"] === "1" ? 3 : Infinity;
        const st = { timer: undefined as unknown as ReturnType<typeof setTimeout>, sent: "" };
        streams.set(msg.id, st);
        let i = 0;
        const step = (): void => {
          if (i >= errorAfter) {
            streams.delete(msg.id);
            emit({ type: "error", id: msg.id, message: "The model ran out of room." });
            return;
          }
          if (i >= words.length) {
            streams.delete(msg.id);
            emit({ type: "result", id: msg.id, text: st.sent, tokensIn: 12, tokensOut: words.length });
            return;
          }
          const chunk = (i === 0 ? "" : " ") + words[i];
          st.sent += chunk;
          i++;
          emit({ type: "chunk", id: msg.id, text: chunk });
          st.timer = setTimeout(step, delayMs);
        };
        st.timer = setTimeout(step, delayMs);
      },
      on: (event, cb) => {
        if (event === "message") listeners.message.push(cb as (m: FromChild) => void);
      },
      kill: () => {
        for (const s of streams.values()) clearTimeout(s.timer);
        streams.clear();
      },
    };
  };
}

// A dev/test seam (unpackaged only): redirect the model DOWNLOAD fetch to a loopback
// fixture so the app e2e exercises the real streaming + sha256 downloader without a 2 GB
// transfer. The catalog url stays a real https link (validator-happy, receipt shows the
// real host); only the bytes come from the fixture. Inert (undefined) when packaged.
function downloadFetchSeam(): typeof fetch | undefined {
  if (app.isPackaged) return undefined;
  const override = process.env["SKOVERN_MODEL_DOWNLOAD_URL"];
  return override ? ((() => fetch(override)) as typeof fetch) : undefined;
}

// One warm embedded engine for the app's life.
let llama: LlamaEngine | null = null;
function makeLlamaEngine(): LocalEngine {
  if (!llama) {
    llama = llamaEngine({ models: () => latestEmbedded, fetchSink: fileFetchSink(), spawn: fakeLlamaSpawn(), fetchImpl: downloadFetchSeam(), idleMs: idleUnloadMs() });
  }
  return llama;
}

// Idle-unload interval seam (unpackaged dev/test only): shrink the 5-min default so the app
// e2e can watch a model unload — and the chip go gray — without waiting 5 minutes. A bad
// value is ignored (undefined → the engine's 5-min default). Inert when packaged.
export function idleUnloadMs(): number | undefined {
  const override = !app.isPackaged ? process.env["SKOVERN_IDLE_UNLOAD_MS"] : undefined;
  const n = override ? Number(override) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Is the active local model resident RIGHT NOW (drives the sidebar chip: green loaded,
 *  gray unloaded)? Embedded → the warm child; Ollama → its `/api/ps`. Best-effort: any
 *  probe failure reads as "not loaded", never throws. The `SKOVERN_BRAIN_LOADED` dev seam
 *  (unpackaged only) forces the answer so the e2e is deterministic on any machine. */
export async function modelLoaded(modelId: string | null): Promise<boolean> {
  const forced = !app.isPackaged ? process.env["SKOVERN_BRAIN_LOADED"] : undefined;
  if (forced === "1") return true;
  if (forced === "0") return false;
  if (!modelId) return false;
  if (isEmbeddedModel(modelId)) return llama?.isWarm() ?? false;
  const resident = await ollamaResidentModels(ollamaBaseUrl());
  return resident.includes(modelId);
}

/** Dispatch a chosen model to its backend: a model with a catalog `gguf` block runs on
 *  the EMBEDDED runtime (no Ollama needed); anything else runs on Ollama. */
export function engineForModel(modelId: string): LocalEngine {
  return isEmbeddedModel(modelId) ? makeLlamaEngine() : makeEngine();
}

/** Does this model run on the embedded runtime (vs Ollama)? Lets callers phrase an
 *  honest failure — an embedded model's problem is never "Ollama isn't running". */
export function isEmbeddedModel(modelId: string): boolean {
  return latestEmbedded.some((m) => m.id === modelId);
}

/** Kill the embedded child (called on app quit). */
export function disposeLocal(): void {
  llama?.dispose();
  llama = null;
}

// The configured local brain's model id, or null (the "active" model in the manager).
function activeLocalModelId(): string | null {
  const b = loadBrain();
  return b?.provider === "local" ? b.model ?? null : null;
}

/** `local:downloadedModels` — the "Your models" view: every embedded GGUF on disk with its size
 *  + catalog label, which one is the active brain, and which one (if any) is resident in VRAM now.
 *  The Memory row covers the EMBEDDED model we run + can free; Ollama manages its own memory. */
export async function downloadedModelsView(): Promise<YourModelsView> {
  const files = await listDownloadedModels();
  const active = activeLocalModelId();
  const models = files.map((f) => {
    const cat = latestEmbedded.find((m) => m.gguf.filename === f.filename);
    return {
      filename: f.filename,
      id: cat?.id ?? f.filename,
      label: cat?.label ?? f.filename,
      size: fmtGB(f.sizeBytes) ?? `${f.sizeBytes} B`,
      active: cat !== undefined && cat.id === active,
    };
  });
  // What's resident RIGHT NOW, for the Memory row. Prefer the warm embedded child's model; else
  // ask Ollama what it has loaded (`/api/ps`) — so the button appears + frees for the Ollama path
  // too, not only the embedded one (BUG B). Best-effort: an Ollama probe failure reads as nothing.
  const warmEmbedded = (llama?.isWarm() ?? false) && active !== null && isEmbeddedModel(active);
  let loadedLabel: string | null = warmEmbedded ? models.find((m) => m.id === active)?.label ?? null : null;
  if (!loadedLabel) {
    const resident = await ollamaResidentModels(ollamaBaseUrl());
    if (resident.length > 0) loadedLabel = resident[0]!; // the model name Ollama reports it has loaded
  }
  return { models, loadedLabel, folder: modelsDir() };
}

/** `local:freeMemory` — reclaim VRAM on demand across BOTH runtimes: unload the resident embedded
 *  model AND tell Ollama to unload whatever it has loaded (keep_alive:0). Refuses (freed:false)
 *  while an embedded reply is generating, so it never yanks the model mid-answer — and in that case
 *  it leaves Ollama alone (the active brain is embedded then). */
export async function freeMemory(): Promise<{ freed: boolean }> {
  if (llama && !llama.unload()) return { freed: false }; // embedded mid-reply — never yank it
  // Embedded freed (or nothing embedded loaded). Now free any Ollama-resident model's VRAM too.
  const base = ollamaBaseUrl();
  const resident = await ollamaResidentModels(base);
  await Promise.all(resident.map((id) => ollamaUnload(base, id)));
  return { freed: true };
}

/** `local:revealModels` — open the folder where OUR downloaded brains live, in the OS file manager.
 *  A FIXED app-owned path (userData/models), no renderer/user input — no traversal surface. */
export async function openModelsFolder(): Promise<void> {
  await shell.openPath(modelsDir());
}

/** `local:deleteModel` — delete a downloaded model file to reclaim disk. If it's the model
 *  loaded in VRAM, free it first (the warm child holds the weights even after the file is gone).
 *  If it's the ACTIVE brain, clear the brain pointer so nothing dangles at a deleted file — the
 *  app degrades to the honest no-brain state (033's fallback / setup CTA). The filename is
 *  validated + confined to the models dir inside `deleteDownloadedModel` (path-sink guard). */
export async function deleteLocalModel(filename: string): Promise<LocalActionResult> {
  const embedded = latestEmbedded.map((m) => ({ id: m.id, filename: m.gguf.filename }));
  const plan = modelDeletionPlan(filename, activeLocalModelId(), llama?.isWarm() ?? false, embedded);
  if (plan.unload) llama?.unload(); // free its VRAM before it's gone (the warm child holds the weights)
  const removed = await deleteDownloadedModel(filename); // validates the name + confines, then unlinks
  if (removed && plan.clearBrain) clearBrain(); // no dangling active pointer to a deleted file
  return { ok: removed, message: removed ? "" : "That model file was already gone." };
}

function fmtGB(bytes: number | null): string | null {
  if (bytes === null) return null;
  const gb = bytes / GB;
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

function hardwareView(p: HardwareProfile): HardwareView {
  const ram = fmtGB(p.ramBytes);
  const disk = fmtGB(p.diskFreeBytes);
  let gpu: string;
  if (p.unifiedMemory) {
    gpu = "Apple unified memory (shared with your apps)";
  } else if (p.bestVramBytes !== null) {
    const best = p.gpus.find((g) => g.vramBytes === p.bestVramBytes);
    gpu = `${best?.model ?? "Graphics card"} (${fmtGB(p.bestVramBytes)})`;
  } else if (p.gpus.length > 0) {
    gpu = `${p.gpus[0]!.model} (memory unknown)`;
  } else {
    gpu = "No separate graphics card we can use";
  }
  return {
    ram: ram ? `${ram} memory` : "Memory unknown",
    cpu: p.cpuCores ? `${p.cpuCores} processor cores` : "Processor unknown",
    gpu,
    disk: disk ? `${disk} free to store models` : "Free space unknown",
    notes: p.notes,
  };
}

async function detectAndList(engine: LocalEngine): Promise<{ ready: boolean; have: LocalModelInfo[] }> {
  const ready = await engine.detect();
  if (!ready) return { ready: false, have: [] };
  try {
    return { ready: true, have: await engine.listModels() };
  } catch {
    return { ready: true, have: [] };
  }
}

/** `local:status` — is Ollama here + how this computer looks + the verdict over
 *  the catalog suggestions (so the headline is meaningful even before a pick). */
export async function localStatus(): Promise<LocalStatusView> {
  const engine = makeEngine();
  const [profile, catalog, det] = await Promise.all([
    scanProfile(),
    loadCatalog(fileFetchSink(), catalogUrl()),
    detectAndList(engine),
  ]);
  rememberEmbedded(catalog.models);
  const v = verdict(profile, builtInCandidates(catalog.models));
  const installed = ollamaInstalled();
  return {
    ollamaReady: det.ready,
    ollamaInstalled: installed,
    hardware: hardwareView(profile),
    verdict: v,
    // An embedded model runs WITHOUT Ollama, so don't nag about Ollama when one exists. If
    // Ollama IS installed but not running, the screen offers a one-click start (no nag here).
    notice:
      det.ready || hasEmbedded() || installed
        ? ""
        : "Ollama isn't running on this computer. It's the free helper that runs a private brain — start it, then choose \"Check my computer again\".",
  };
}

/** `local:models` — both groups fit-checked. Catalog models are the suggestions
 *  (marked downloaded/needs-download); any pulled model NOT in the catalog is the
 *  user's own, shown under "what you already have". */
export async function localModels(): Promise<LocalModelsView> {
  const engine = makeEngine();
  const [profile, catalog, det] = await Promise.all([
    scanProfile(),
    loadCatalog(fileFetchSink(), catalogUrl()),
    detectAndList(engine),
  ]);

  rememberEmbedded(catalog.models);
  const haveIds = new Set(det.have.map((m) => m.id));
  const catalogIds = new Set(catalog.models.map((m) => m.id));
  const ownHave = det.have.filter((m) => !catalogIds.has(m.id));

  // Two passes, one per concern:
  //  - DISPLAY tier of EVERY row (built-in + Ollama catalog suggestions + own pulled models)
  //    comes from a verdict over ALL of them, so an Ollama model shows its REAL fit — a small
  //    one on a big card is green, not a default amber (BUG A / loop 042).
  //  - The RECOMMENDATION comes from a separate built-in-only pass — the SAME call as
  //    `localStatus`, so the headline and the hero still name the same model, and a background
  //    Ollama can never become the pick (037 flip-kill preserved).
  const vDisplay = verdict(profile, allCandidates([...catalog.models, ...ownHave]));
  const tierOf = (id: string) => vDisplay.fits.find((f) => f.modelId === id);
  const recommendedModelId = verdict(profile, builtInCandidates(catalog.models)).recommendedModelId;

  const suggested: LocalModelView[] = catalog.models.map((c: CatalogModel) => {
    const fit = tierOf(c.id);
    // An embedded model is "downloaded" when its verified file is on disk (not Ollama);
    // it's actionable WITHOUT Ollama, so the view keeps its button live.
    const embedded = c.gguf !== undefined;
    const downloaded = embedded ? modelDownloaded(c.gguf!.filename) : haveIds.has(c.id);
    return {
      id: c.id,
      label: c.label,
      group: "suggested",
      downloaded,
      embedded,
      tier: fit?.tier ?? "amber",
      usable: fit?.usable ?? true,
      note: fit?.note ?? "",
      recommended: recommendedModelId === c.id,
      creator: c.creator,
      homepage: c.homepage,
      license: c.license,
      licenseUrl: c.licenseUrl,
      tradeoff: c.tradeoff,
      size: fmtGB(c.sizeBytes) ?? undefined,
    };
  });

  const have: LocalModelView[] = ownHave.map((m) => {
    const fit = tierOf(m.id);
    return {
      id: m.id,
      label: m.label,
      group: "have",
      downloaded: true,
      tier: fit?.tier ?? "amber",
      usable: fit?.usable ?? true,
      note: fit?.note ?? "",
      recommended: recommendedModelId === m.id,
      size: m.sizeBytes ? fmtGB(m.sizeBytes) ?? undefined : undefined,
    };
  });

  // Only nag about Ollama when there's no embedded model the user could run instead.
  const notice =
    !det.ready && !hasEmbedded()
      ? "Ollama isn't running — start it and choose \"Check my computer again\" to see your models."
      : catalog.notice ?? "";

  return { ollamaReady: det.ready, models: [...have, ...suggested], notice };
}

/** Start pulling a model, forwarding progress. Routes to the embedded downloader for a
 *  gguf model, or Ollama's pull otherwise. Rejects (descriptively) on failure. */
export function pullModel(modelId: string, onProgress: (p: PullProgress) => void): Promise<void> {
  return engineForModel(modelId).pull(modelId, onProgress);
}
