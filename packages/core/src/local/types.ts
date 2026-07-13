// The Local Brain spine: a pluggable on-device engine, the hardware honesty
// types, and the curated-catalog shape. The router talks to a `Provider` (011);
// a `local` Provider is backed by a `LocalEngine`, so adding a backend (Ollama
// now, embedded llama.cpp later) never touches the router or a skill.

/** A model an engine can run right now. Ollama: something the user has pulled. */
export interface LocalModelInfo {
  /** Engine-native id (e.g. "qwen2.5:3b"). */
  id: string;
  /** Human name to show. */
  label: string;
  /** Size in billions of parameters, if known. */
  params?: number;
  /** On-disk footprint in bytes, if known. */
  sizeBytes?: number;
  /** Quantization tag (e.g. "Q4_K_M"), if known. */
  quant?: string;
}

/** The result of one local generate: the reply text plus, when the engine reports
 *  them, the tokens it read/produced — so a private-brain receipt can show tokens
 *  ("all on your computer") instead of bytes. Counts are `undefined` when the engine
 *  doesn't report them (older Ollama, some models), never faked to 0. */
export interface LocalGenerateResult {
  text: string;
  tokensIn?: number;
  tokensOut?: number;
}

/** One progress tick while pulling a model. Ollama streams these as newline JSON. */
export interface PullProgress {
  /** Engine status line ("pulling manifest", "downloading", "success"…). */
  status: string;
  /** Bytes fetched so far, if the engine reports it. */
  completed?: number;
  /** Total bytes for the current layer, if known. */
  total?: number;
  /** 0–100 overall, our own derivation for the progress bar. */
  percent?: number;
}

/** The on-device runtime behind a `local` Provider. Every method turns a failure
 *  into a REJECTION with a specific, plain-language message — never an async throw
 *  that could crash the host process. */
export interface LocalEngine {
  /** Present + reachable right now? (e.g. Ollama answering on 127.0.0.1:11434). */
  detect(): Promise<boolean>;
  /** Models this engine can run right now. */
  listModels(): Promise<LocalModelInfo[]>;
  /** Run a prompt on one model. Returns the reply text plus optional token counts.
   *  Rejects (never crashes) on failure. */
  generate(modelId: string, prompt: string): Promise<LocalGenerateResult>;
  /** Fetch a model the engine doesn't have yet, reporting progress. Rejects on failure. */
  pull(modelId: string, onProgress?: (p: PullProgress) => void): Promise<void>;
}

/** One graphics device we detected. VRAM is the primary usability signal. */
export interface GpuInfo {
  model: string;
  /** Dedicated video memory in bytes, or null if we couldn't read it. */
  vramBytes: number | null;
  vendor?: string;
}

/** Best-effort, cross-platform snapshot of what this computer can do. Every field
 *  is nullable: when a probe can't read something, we say so honestly in `notes`
 *  rather than invent a number. */
export interface HardwareProfile {
  /** Total system RAM in bytes, or null if unknown. */
  ramBytes: number | null;
  /** Logical CPU cores, or null if unknown. */
  cpuCores: number | null;
  /** Every GPU controller we could see (best-effort — see spec). */
  gpus: GpuInfo[];
  /** Largest dedicated VRAM across `gpus` in bytes, null if none has readable VRAM. */
  bestVramBytes: number | null;
  /** True when "GPU memory" is really shared system RAM (Apple unified memory). */
  unifiedMemory: boolean;
  /** Free disk in bytes on the drive we'd store models, null if unknown. */
  diskFreeBytes: number | null;
  /** Honest degradation notes ("we couldn't detect your graphics memory…"). */
  notes: string[];
}

/** Where + how to fetch a model for the EMBEDDED runtime (node-llama-cpp). Present
 *  only on catalog models we can run without Ollama; absent → Ollama-only. Untrusted
 *  network input (it rides in the fetched catalog) — validated on load: https-only
 *  url, 64-hex sha256, a filename with no path separators. */
export interface GgufSource {
  /** Direct https GGUF URL (e.g. a Hugging Face `resolve` link; may 302 to a CDN). */
  url: string;
  /** Expected file sha256, lowercase hex (64 chars) — the integrity gate. */
  sha256: string;
  /** Expected download size in bytes (progress + a free-disk check). */
  sizeBytes: number;
  /** Local filename under userData/models — safe charset, no separators or "..". */
  filename: string;
  /** Context window to allocate when the child loads it (e.g. 4096). */
  contextSize: number;
}

/** One curated model in `catalog/models.json`. Untrusted network input once
 *  fetched — every string is validated on load and escaped on render. */
export interface CatalogModel {
  /** Ollama-native id (e.g. "qwen2.5:3b"). */
  id: string;
  label: string;
  /** Billions of parameters. */
  params: number;
  /** On-disk footprint in bytes. */
  sizeBytes: number;
  quant: string;
  /** Who made it (NOT Deskhand). */
  creator: string;
  /** Homepage / model card URL (http(s) only). */
  homepage: string;
  /** Its license in plain words ("Apache 2.0 — free to use"). */
  license: string;
  /** Link to the full license text (http(s) only). */
  licenseUrl: string;
  /** One-line honest trade-off ("fastest, lighter answers"). */
  tradeoff: string;
  /** Present only for models runnable with the embedded runtime (no Ollama needed). */
  gguf?: GgufSource;
}

/** Green / amber / red per the honesty engine. */
export type FitTier = "green" | "amber" | "red";

/** How one model fits this computer. */
export interface ModelFit {
  modelId: string;
  tier: FitTier;
  /** False only when the model won't run at all (red). Amber = runs, but slowly. */
  usable: boolean;
  /** Plain-language, warm one-liner for this model on this machine. */
  note: string;
}

/** The verdict pure function's output: per-model fit + one warm overall line. */
export interface Verdict {
  fits: ModelFit[];
  /** The model we'd steer a user to, or null when nothing local is worth it. */
  recommendedModelId: string | null;
  /** True when at least one genuinely good (fast, capable) local option exists. */
  canRunGoodOne: boolean;
  /** One warm, honest sentence for the whole computer — includes the "use the
   *  cloud brain instead" case when no good local option exists. */
  headline: string;
}

/** What `verdict()` scores a model against — a subset of `LocalModelInfo` plus the
 *  guaranteed `params` a catalog model has. */
export interface VerdictModel {
  id: string;
  label: string;
  params: number;
  sizeBytes?: number;
}
