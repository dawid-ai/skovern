# Spec: Local Brain — a private, free, on-device option

**Status:** draft — awaiting Dawid's review
**Date:** 2026-07-12
**Author:** brainstormed with Dawid (2026-07-11/12)
**Scope of THIS spec:** the overall Local Brain design + the detailed contract for
**Loop 1 (the spine + Ollama backend)**. Loops 2–3 are sketched, not specified.

## Why

Every Deskhand skill today needs a brain the user pays for or brings: an OpenRouter/
Anthropic key, or their Claude Code subscription (014). A non-technical florist with
**neither** has no way to run anything. The Local Brain closes that gap: a **free,
private, on-device** brain. It's the product's "free & private" promise made real —
the model runs on the user's own machine, so **nothing leaves it**.

## The core design decision: a pluggable `LocalEngine`

"The local runtime" is not one thing. We define a small interface and put backends
behind it, so the router/skills never know or care which is running:

```ts
// packages/core — the router talks to a Provider (011); a `local` Provider is
// backed by a LocalEngine. Adding a backend never touches the router or skills.
export interface LocalModelInfo {
  id: string;              // engine-native id (e.g. "qwen2.5:3b")
  label: string;           // human name
  params?: number;         // billions, if known
  sizeBytes?: number;      // on-disk footprint, if known
  quant?: string;          // e.g. "Q4_K_M"
}

export interface LocalEngine {
  /** Present + reachable right now? (e.g. Ollama running on :11434) */
  detect(): Promise<boolean>;
  /** Models this engine can run right now (Ollama: what the user has pulled). */
  listModels(): Promise<LocalModelInfo[]>;
  /** Run a prompt on one model. Throws (never crashes the host) on failure. */
  generate(modelId: string, prompt: string): Promise<string>;
}
```

**Backends** (behind this one interface):
- **Ollama** (Loop 1): if the user already runs Ollama (`localhost:11434`), use *its*
  models. Zero download, always-current runtime + models (Ollama owns that), **no
  native dependency**. Talking to loopback is on-machine → still "nothing left."
- **Embedded `node-llama-cpp`** (Loop 2): the zero-setup path for a user who's never
  heard of Ollama — we manage the model file + the runtime via a maintained binding
  with prebuilt native binaries (same packaging posture we accepted for
  `@resvg/resvg-js`).

This reconciles the original "no Ollama" rule: we never *require* Ollama or a terminal
— we *use* it only if it's already there.

### Updatability (a Dawid concern — answered by design)

Two clocks, only one slow:
- **The model catalog is data** (a JSON list). Host it remotely → new models appear
  **without an app update**. Fast clock, our control.
- **The engine version** (llama.cpp via node-llama-cpp) updates on **app-release
  cadence**; only a brand-new architecture forces a bump. For Ollama users the runtime
  is *always current* (Ollama updates itself). So the abstraction gives us both a
  self-updating path (Ollama) and a controlled path (embedded) — no lock-in.

## The honesty engine: hardware scan → verdict

The novel, must-be-right part. It judges **usable, not merely "runs."**

- **`HardwareProfile`** — best-effort, cross-platform, platform-guarded:
  total RAM; CPU cores; **GPU(s) + VRAM** (Apple = unified memory); free disk.
  - **Primary criterion is GPU VRAM** (or Apple unified memory).
  - **Enumerate every GPU** and pick the best — a weak iGPU next to a strong dGPU/eGPU
    must recommend the strong one. Honest limitation: reliably listing *all* GPUs
    cross-platform is messy (Windows WMI/`nvidia-smi`, macOS `system_profiler`/Metal,
    Linux `nvidia-smi`/`vulkaninfo`/`lspci`). The **accelerated device the engine will
    actually use** (which governs usability) is the reliable signal; a broader "all
    your GPUs" list is best-effort and clearly labeled as such.
- **`verdict(profile, models)`** — a **pure function** (the testable backbone):
  - Per model: **fit** = footprint (quant size + KV-cache for a real context window,
    e.g. 4k) vs VRAM/unified-mem **with headroom**; **usability** downgrades CPU-only
    inference past ~3B to "runs, but painfully slow."
  - Output: green/amber/red per model + one **warm plain-language** overall verdict +
    a recommended model. Must be able to say honestly **"your machine can't run a good
    private brain — the free cloud brain or your subscription will serve you better."**
    No false hope.
  - **A suggestion, never a gate.** The user can ignore it and run anyway; we show the
    trade-off honestly ("you *can* run this — it'll be very slow; your best pick is X").

There is **no turnkey "best model for this hardware" API** — LM Studio / Ollama / Jan
each compute this themselves at runtime over their own catalog. We implement the same
well-understood heuristic over our maintainable (remote-updatable) catalog.

## UX / IA

- The **Settings brain-picker** (011/014) gains **"On this computer — free & private."**
- Choosing it opens a dedicated **local-brain setup view** (its own place, per the IA
  rule): the **hardware verdict**, the runnable models with **fit dots**, a
  **recommended** one up front and an **"Advanced / see all models"** reveal for the
  curious, and a **"Check my computer again"** action (re-scan is always available —
  hardware changes, upgrades, and especially **migrating the tool to a new machine**,
  where settings travel but the model file may not).
- **Per-model transparency** (plain language, for a non-tech user): each model says
  *"Made by XYZ, not by Deskhand — a free file you run privately. Where it comes from →"*
  with a real link to its Hugging Face / homepage + its license in plain words. (Most
  relevant to Loop 2's download flow; Loop 1 shows provenance where Ollama exposes it.)
- **Receipts:** a `local` call has **no egress**, so its receipt reads **"stayed on
  your computer — nothing left,"** not a false "sent." This makes the privacy claim
  *visible* on the receipts panel (015).

---

## Loop 1 — the spine + Ollama backend (the buildable contract)

**Goal:** a user who runs Ollama can pick "On this computer," see an honest verdict for
their machine + models, choose one, and run a real skill on it — with the receipt
proving nothing left the machine. Builds the whole spine (interface, verdict, provider,
receipts, UI, re-scan) with **no native dep and no multi-GB download**.

### In scope
- `LocalEngine` interface + **Ollama backend** (`detect` via `GET /api/tags`;
  `listModels` from the tags; `generate` via `/api/generate` or `/api/chat`).
- `HardwareProfile` scan (best-effort GPU/VRAM + RAM/CPU/disk) + `verdict()` pure fn.
- `local` provider in the router (`ProviderId += "local"`), backed by the Ollama
  engine; selected by `buildRouter()`; robust — a dead/again Ollama yields a friendly
  failure, never a main-process crash (the `claude-cli`/`collectOutput` discipline).
- **No-egress receipts** for `local` calls (router receipt logic marks provider
  `local` as on-machine — "stayed on your computer").
- Settings brain-picker option + the local-brain setup view (verdict, model list w/
  fit dots, recommended + Advanced reveal, **re-scan**).
- **Loopback-only guard:** the Ollama base URL is `http://127.0.0.1:11434` by default;
  any override is a dev/test seam (`DESKHAND_OLLAMA_URL`, gated `!app.isPackaged`), so
  the "local" backend can never be pointed at a remote host to exfiltrate prompts.

### Metric (loop contract will formalize)
- **Unit — verdict honesty table:** potato / laptop / workstation profiles ×
  representative models → correct fit + usability + the right plain verdict, **including
  the "can't run well → use the cloud" case**.
- **Unit — Ollama backend:** parses `/api/tags`, `generate` returns text, and every
  failure mode (Ollama down, non-200, malformed) becomes a friendly rejection, not a
  crash. Against a **fixture HTTP server**, not a real Ollama, in CI.
- **Unit/negative — no false egress:** a `local` generate writes a receipt marked
  on-machine (no network "sent" line); assert the receipt shape.
- **Negative — loopback guard:** a non-loopback `DESKHAND_OLLAMA_URL` is refused when
  packaged (or the override is inert when packaged). Assert it can't point off-box.
- **App e2e:** Settings → "On this computer" → (fixture Ollama w/ fake models) →
  verdict + model list render → pick one → run a skill → the Receipts page shows a
  **"stayed on your computer"** entry, no egress line.
- **Hand-validation (Dawid):** with a **real** Ollama running, the flow works end to
  end on a real model.

### Out of scope (→ later loops)
- **Loop 2:** embedded `node-llama-cpp` runtime + the curated model **catalog** +
  **download-with-progress + sha256 gate** + the per-model transparency download flow.
  Slots in as `LocalEngine` backend #2 behind the proven interface.
- **Loop 3:** the honest **upgrade/buy guide** (affiliate links w/ dual-button
  transparency) + community hardware-guide JSON.
- Exhaustive all-GPU enumeration polish (Loop 1 = best-effort single best device).

### Security notes (for the reviewer)
- **Loopback-only** for the Ollama backend (above) — the whole "local = private" claim
  depends on it; the override must be inert when packaged. (Testable → metric.)
- **No false egress receipt** for local calls; and if the download path ever lands
  (Loop 2) that download IS egress and must be receipted.
- **Untrusted model output** from a local model is the same untrusted text as any
  brain — it flows through the existing escaping (render/markdown) unchanged.
- Robustness: a local backend can never crash the trusted main process (mirror
  `claude-cli`).

## Open questions for Dawid
1. Loop 1 shows the user's **already-pulled** Ollama models. Do you also want it to
   **suggest models to pull** (with a copy-paste `ollama pull …` hint) in Loop 1, or
   keep Loop 1 to "use what you have" and leave model-getting to Loop 2's embedded
   downloader? (Default: use-what-you-have; simplest.)
2. The remote-updatable catalog (host the models JSON so new models ship without an app
   update): build the remote-fetch in Loop 2 (when it first matters), or bake a local
   JSON now and add remote later? (Default: local JSON now, remote in Loop 2.)
