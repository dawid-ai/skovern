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
- **The model catalog is data** (a JSON list), and it's **live from day one.** It lives
  in a dedicated **`catalog/` folder in this public repo** and the app **fetches it at
  use-time** from `https://raw.githubusercontent.com/dawid-ai/deskhand/main/catalog/models.json`
  (repo is public → unauthenticated). So we ship a new/updated model list by **merging a
  JSON change — no app update.** A **bundled snapshot** is the offline fallback; the
  catalog fetch is **egress → receipted** ("checked the model list · github.com"); a
  failed/missing/malformed fetch surfaces a **descriptive error** and falls back to the
  snapshot, never a silent break.
- **The engine version** (llama.cpp via node-llama-cpp) updates on **app-release
  cadence**; only a brand-new architecture forces a bump. For Ollama users the runtime
  is *always current* (Ollama updates itself). So the abstraction gives us both a
  self-updating path (Ollama) and a controlled path (embedded) — no lock-in.

**Descriptive errors everywhere (a Dawid requirement).** Every failure in this flow —
Ollama not running, catalog unreachable, model file missing, a pull that stalls, a
model that won't load — surfaces a **specific, plain-language** message ("We couldn't
reach the model list — check your internet" / "Ollama isn't running — start it and try
again"), not a generic "something went wrong," so a user or support can pinpoint it.

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
  rule): the **hardware verdict**; the models shown in two clear groups —
  **what you already have** (the user's pulled Ollama models, marked "already on your
  computer", fit-checked) and **our suggestions** (a couple of curated picks with their
  **trade-offs** spelled out — e.g. "fastest, lighter answers" vs "smarter, needs more
  memory / slower", each marked *already downloaded* or *needs a download*); the **best
  choice highlighted** (whether it's already downloaded or needs a fresh pull); an
  **"Advanced / see all models"** reveal; and a **"Check my computer again"** action
  (re-scan is always available — hardware changes, upgrades, and especially **migrating
  the tool to a new machine**, where settings travel but the model file may not).
- **Getting a suggested model needs no downloader of ours in Loop 1:** a "Get this one"
  on a not-yet-downloaded suggestion calls **Ollama's own pull API** (`POST /api/pull`,
  streamed) and shows a progress bar — Ollama does the fetching, so still no native dep
  and no download plumbing on our side.
- **Per-model transparency** (plain language, for a non-tech user): each suggestion says
  *"Made by XYZ, not by Deskhand — a free file you run privately. Where it comes from →"*
  with a real link to its Hugging Face / homepage + its license in plain words.
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
- `LocalEngine` interface + **Ollama backend**: `detect` via `GET /api/tags`;
  `listModels` from the tags; `generate` via `/api/generate` or `/api/chat`; **`pull`
  via `POST /api/pull`** (streamed progress) for getting a suggested model.
- **Curated model catalog**, live: `catalog/models.json` in this repo, **fetched at
  use-time** from raw.githubusercontent + **bundled snapshot fallback**; the fetch is
  **receipted** (github) and a failure surfaces a **descriptive error** + falls back.
  Each entry: id, label, params, size, quant, **creator, homepage/HF link, license
  (plain words)**, and a short **trade-off blurb**.
- `HardwareProfile` scan (best-effort GPU/VRAM + RAM/CPU/disk) + `verdict()` pure fn.
- `local` provider in the router (`ProviderId += "local"`), backed by the Ollama
  engine; selected by `buildRouter()`; robust — a dead/absent Ollama yields a friendly
  **descriptive** failure, never a main-process crash (the `claude-cli`/`collectOutput`
  discipline).
- **No-egress receipts** for `local` generate calls (router receipt logic marks
  provider `local` as on-machine — "stayed on your computer").
- Settings brain-picker option + the local-brain setup view: **what-you-have** vs
  **our-suggestions** (trade-offs, downloaded/needs-download, best highlighted), fit
  dots, per-model transparency + link, **"Get this one" → Ollama pull w/ progress**,
  **Advanced** reveal, **re-scan**.
- **Descriptive errors** across the flow (Ollama down, catalog unreachable, pull
  failed, model won't load).
- **Loopback-only guard:** the Ollama base URL is `http://127.0.0.1:11434` by default;
  any override is a dev/test seam (`DESKHAND_OLLAMA_URL`, gated `!app.isPackaged`), so
  the "local" backend can never be pointed at a remote host to exfiltrate prompts.

### Metric (loop contract will formalize)
- **Unit — verdict honesty table:** potato / laptop / workstation profiles ×
  representative models → correct fit + usability + the right plain verdict, **including
  the "can't run well → use the cloud" case**.
- **Unit — Ollama backend:** parses `/api/tags`, `generate` returns text, `pull`
  streams progress, and every failure mode (Ollama down, non-200, malformed) becomes a
  **specific descriptive** rejection, not a crash. Against a **fixture HTTP server**,
  not a real Ollama, in CI.
- **Unit — catalog:** live fetch parses a valid `models.json`; a failed/malformed fetch
  **falls back to the bundled snapshot** and yields a **descriptive** error/notice; the
  fetch writes a **github receipt**. (Fixture server, not real GitHub, in CI.)
- **Unit/negative — no false egress:** a `local` generate writes a receipt marked
  on-machine (no network "sent" line); assert the receipt shape.
- **Negative — loopback guard:** a non-loopback `DESKHAND_OLLAMA_URL` is refused when
  packaged (or the override is inert when packaged). Assert it can't point off-box.
- **App e2e:** Settings → "On this computer" → (fixture Ollama + fixture catalog) →
  verdict + "what you have" + "our suggestions" (trade-offs, download state) render →
  pick an already-downloaded model → run a skill → the Receipts page shows a
  **"stayed on your computer"** entry (no egress line) **and** a github catalog receipt.
- **Hand-validation (Dawid):** with a **real** Ollama running, the flow works end to
  end on a real model (incl. a "Get this one" pull if a suggestion isn't downloaded).

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
- **No false egress receipt** for local *generate* calls (they stay on-machine). But
  the **catalog fetch IS egress** (to github) and **must be receipted** in Loop 1; the
  Loop 2 model download likewise.
- **Untrusted catalog:** `models.json` is fetched from the network, so it's untrusted
  input — validate its shape, and treat every string (labels, links, blurbs) as
  untrusted when rendered (escape; links get `rel="noreferrer"`, no `javascript:`).
- **Untrusted model output** from a local model is the same untrusted text as any
  brain — it flows through the existing escaping (render/markdown) unchanged.
- Robustness: a local backend can never crash the trusted main process (mirror
  `claude-cli`).

## Resolved (Dawid, 2026-07-12)
1. **Show both** — the user's already-pulled Ollama models (marked "already on your
   computer") **and** our curated suggestions with trade-offs (marked downloaded /
   needs-download), best choice highlighted. Getting a not-downloaded suggestion uses
   **Ollama's own pull API** (progress bar) — no downloader of ours in Loop 1.
2. **Live catalog now** — `catalog/models.json` in this public repo, fetched at
   use-time (raw.githubusercontent), bundled-snapshot fallback, receipted, descriptive
   errors. Not deferred.
3. **Descriptive errors** are a cross-cutting requirement for the whole flow.
