# Local Brain: built-in default + connect-your-own (advanced)

**Status:** design — awaiting Dawid's review
**Date:** 2026-07-17
**Author:** brainstorm w/ Dawid (hands-on feedback on loops 032–035)
**Supersedes the default-path parts of:** the Ollama-first local-brain flow (019–024) as re-shaped by the embedded runtime (026–035)

---

## Problem (what Dawid hit hands-on)

Two things break the first-run experience for a non-technical user:

1. **Two competing "brains."** Onboarding shows a **built-in brain** (a model file Skovern
   downloads and runs itself, no external program) AND **your Ollama models** (a separate program
   the user may have installed) as if they're rival choices. A florist shouldn't know either
   exists. Per our own copy rule, **Ollama is plumbing and should never appear by name** in the
   guided path.
2. **The recommended model flips.** The pick = "biggest model that runs fast AND is gettable
   right now" (`packages/core/src/local/verdict.ts`). "Gettable" *changes the instant Ollama
   starts* (`candidateVerdictModels` in `apps/desktop/src/main/local.ts` adds Ollama-only catalog
   picks + the user's own pulled models once `ollamaReady`), so the recommendation lurches. It
   should pick "the best brain your computer can run, period" — stable, explained, never jumping
   because a background program woke up.

## Root cause

We started Ollama-only (019–024), then added our own embedded llama.cpp runtime (026–032) as a
"guaranteed floor" so a no-Ollama user could still run a private brain. We never went back and
made the built-in engine *the* engine — so both live in the default path and fight.

**Key technical fact that unlocks the fix:** the built-in engine and Ollama are the *same core*
(llama.cpp). Ollama is not a capability we depend on — it's a convenience (model library +
self-management + a power-user's existing downloads). **The real limit on what runs is the GPU,
not whether Ollama is installed.** So the built-in engine can run anything Ollama can, given the
model file — which means we can make it the default for *everyone* and stop depending on Ollama.

## Decision

**Built-in engine owns the default path; every other local runtime is an "Advanced: connect your
own brain by address" option.** Product principle (Dawid): *"You either don't want to touch any
of it, or you're savvy enough to set it up."*

- **Default (everyone, incl. total beginner):** the built-in engine. The word "Ollama" never
  appears. Recommendation is computed from hardware + our built-in catalog only → **it never
  flips** (all built-in models are always gettable, so the condition that moved the pick is gone —
  no new recommendation logic needed).
- **Advanced (power users):** "Connect your own brain" → type an `address:port`. One generic lane
  that covers Ollama, LM Studio, a llama.cpp server, a LAN box — they all speak a compatible HTTP
  API. Skovern talks to it; it does **not** install or manage it. This is where a power user's
  existing 27B/32B stay usable *without re-downloading*.

**Rejected — Ollama by default (auto-install/run).** Silently installing and babysitting a
third-party program on a non-technical user's machine (AV friction, trust, disk, uninstall, their
version drift as a failure surface we don't control) costs more than it saves. Its one real
advantage — a self-updating engine — is neutralized below.

### The update-cadence tradeoff (accepted, with eyes open)

The built-in engine (llama.cpp) is **baked into the app build**, so a newer engine (new-model
support, speed) requires an **app update**, not a background pull. Ollama self-updates. We accept
this because, given the 1+3 split, the lag hurts neither user:

- We **control the built-in catalog** → we only ever offer a model the shipped engine already
  runs, so a beginner never hits "needs a newer engine."
- The **bleeding-edge crowd uses the Advanced lane** with their own, always-fresh runtime.
- "Engine updates ride app updates" is normal (Chrome/VS Code/Slack).

**Prerequisite (not free):** "the built-in engine stays current" depends on shipping **app
auto-update + real code-signing** — not built yet (it's what errored at the end of the
`dist:win` run on 2026-07-17). Tracked in ledger `code-signing-notarization`. *Future escape
hatch (YAGNI for now): ship the engine binary as a downloadable component so it updates without a
full app rebuild.*

## Architecture

```
                    ┌─────────────────────────────────────────┐
   Guided path  →   │  Built-in engine (node-llama-cpp)        │
   (everyone)       │  - our catalog (tiered GGUFs we host)    │
                    │  - we download + run + receipt + update  │
                    │  - GPU is the only limit                 │
                    └─────────────────────────────────────────┘
                    ┌─────────────────────────────────────────┐
   Advanced     →   │  Connect-by-address (one generic lane)   │
   (Settings)       │  - Ollama / LM Studio / llama.cpp / LAN  │
                    │  - localhost → light confirm             │
                    │  - off-box  → egress warning + receipts  │
                    │  - we talk to it; we don't manage it     │
                    └─────────────────────────────────────────┘
```

### Stable recommendation (the flip dies for free)

The verdict engine (`verdict.ts`) already scores every model green/amber/red by fit and picks the
biggest green+capable **gettable** one. In the new world **every built-in model is always
gettable**, so the pick is simply "biggest fast+capable in our catalog for this GPU" — stable, no
new logic. The change is in `local.ts`: the default verdict scores **only the built-in catalog**,
never Ollama-derived candidates. Ollama models influence nothing in the guided path.

### Catalog coverage (one solid built-in per hardware tier)

| Machine | Brain | Status |
|---|---|---|
| Weak laptop / no real GPU | ~1.5B floor | **source + pin the file** (ledger `local-brain-model-floor`) |
| 4–8 GB | ~3B | ✅ have |
| 8–12 GB | ~7–8B | ✅ have |
| 12–16 GB | ~14B | ✅ have |
| 24 GB+ | ~27B / 32B | **currently Ollama-only picks — make them built-in files** |

"Sourcing" a tier = a real GGUF download + sha256 pin added to the catalog + snapshot (reuses the
shipped sha256-gated downloader). A bigger catalog raises the weight of ledger
`local-catalog-integrity-trust` (unsigned catalog, third-party uploader hashes) — sign/host-pin
before wide distribution.

### The guided onboarding flow

1. **Welcome** — "Your own private AI, right on this computer. Nothing you type leaves the
   building." `[Set up my brain]`
2. **Here's your computer** (auto hardware scan, plain language: GPU + memory).
3. **Here's your brain** — **one** recommended pick (hero), size + download time,
   `[Download and set it up]`, plus a quiet `see other options ▾` that reveals the tier list, each
   honestly labelled (fast / a bit slower / won't fit). Kills the "what do I pick" moment.
4. **Download** — honest progress + "staying on your computer ✓" (already built).
5. **Ready → Chat** (onboarding→Chat already fixed in 035).

The flow **never says "Ollama."**

### The advanced lane (Settings → Brain → "Connect your own brain")

- Input: `address:port`. Generic — Ollama, LM Studio, llama.cpp server, LAN box.
- **Ceremony matches whether bytes leave the machine** (Dawid's rule):
  - `localhost`/`127.0.0.1`/`::1` → a single one-time confirm (not leaving the box).
  - any other host → a clear "this will leave your computer" warning **and** every call shows in
    the Receipts log (egress-receipted, consent-gated). This relaxes today's hard loopback-only
    guard (`assertLoopback`) **only** on this explicit advanced path.
- A beginner never sees this screen.

### What gets removed from the default path

The "Start Ollama" prompt, the consent/auto-launch dance (032), the type-a-model-name pull box
(035), and the Ollama status detection collapse into the single "connect by address" lane. Net
deletion, one story.

## Decomposition into loops

Each is a normal loop (SPEC → BUILD → VERIFY → SECURE via `/new-loop` → `/deskhand-loop`). Order
recommended; the plan phase can refine.

- **Loop B — Onboarding re-focus + flip-kill** *(do first; the visible win).* One hero pick +
  `see other options`; `local.ts` scores only built-in catalog for the guided verdict (kills the
  flip); remove Ollama surfaces from the guided screen. Uses the *existing* 3/7/14B catalog — the
  pick is stable immediately; Loop A widens the range. Metric: onboarding e2e drives the real UI,
  asserts one recommended pick, stable across an Ollama-up vs Ollama-down fixture (the exact case
  that flipped before), Ollama word absent.
- **Loop A — Catalog coverage.** Add built-in files for the ~1.5B floor and ~27B/32B top (real
  URL + sha256). *May be gated on sourcing the files* — a large out-of-loop download + pin (I can
  do it, or Dawid provides). Metric: verdict recommends the top-tier built-in for a 24 GB fixture
  profile; the floor for a weak profile; deterministic via the hardware seam.
- **Loop C — Advanced connect-by-address.** Settings UI + a generic HTTP engine target; localhost
  vs off-box ceremony; egress receipts on the off-box path; loopback-guard relaxation scoped to
  this lane. Metric: connect to a fixture server by address; localhost = light confirm; off-box =
  warning + a receipt written before the first byte; e2e drives the real Settings UI.
- **Loop D — Rip-out.** Delete the now-orphaned Ollama-in-default code once B + C give it a new
  home. Metric: the removed surfaces are gone; full suite green; no dead code.

## Out of scope (separate specs / later)

- **Context fuel gauge** (Dawid #4) — its own spec: read a model's context window, estimate usable
  window from VRAM, show live word-count usage in Chat. Independent of this epic.
- **Diagnostics export** (Dawid #5b) — its own spec: a "Save a report for support" file (hardware,
  chosen brain, connection, speeds, errors) for first users.
- **Mac/Linux packaged validation** — Dawid: "much later." Windows-first (`macos-linux-packaged-validation`).
- **Optional "keep my brain warm / never unload"** setting (parked from 034) — a small follow-up,
  not this epic.

## Confirmed working (no action)

- Green/gray chip: loads on chat, frees after 5-min idle — correct (Dawid verified).
- Hide-to-tray: no longer wipes instantly; normal idle-unload applies — correct (Dawid verified).

## Risks / open items

- **Sourcing + pinning the floor and top-tier GGUFs** (Loop A) needs a large real download; may
  block A until done.
- **`local-catalog-integrity-trust`** grows in weight as the catalog grows — sign/host-pin before
  wide distribution.
- **Loopback-guard relaxation** (Loop C) is the first off-box egress from the local-brain path —
  must be consent-gated + fully receipted (ties to `ambient-network-sandbox` posture).
- **App auto-update + signing** (`code-signing-notarization`) is the real prerequisite for the
  built-in engine to stay current — a distribution-phase dependency, not part of MVP usability.
