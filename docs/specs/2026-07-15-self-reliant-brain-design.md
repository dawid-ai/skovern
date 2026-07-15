# Self-reliant local brain — design spec (2026-07-15)

**Status:** draft — awaiting Dawid's approval before the loop contract.
**Loop:** 032 (Dawid chose to combine onboarding + fallback + Ollama consent into ONE loop).

## Purpose

Deskhand must work for a non-technical florist with **nothing installed** and no idea what
Ollama is. Today the local brain silently depends on Ollama being installed AND running; when
it isn't, features just fail. This loop makes the app **self-reliant**: the built-in embedded
runtime (already shipped, loops 026/028/029) becomes the guaranteed floor, external tools
(Ollama, Claude Code CLI) are optional upgrades used only with consent, and a first-run setup
guarantees a working brain with zero external tools.

Origin: Dawid hand-validating loop 031 — chat gave no response because his brain was pinned to
`local:mistral-small` (Ollama) and Ollama wasn't running. A stopgap fallback already shipped
(`HOTFIX-local-brain-fallback`); this loop is the full, correct version.

## Decisions (locked in brainstorming, 2026-07-15)

1. **Built-in is the floor.** The embedded `node-llama-cpp` GGUF runtime (crash-isolated child,
   sha256-gated downloader — already built) is the guaranteed brain. It needs no external tools.
2. **First-run setup flow.** On first install: hardware detection → confirm the runtime is ready
   → detect Ollama (offer with consent) → choose + download a first model → set active. All
   re-runnable/changeable from Settings. (Dawid: "On first install we need a hardware detection
   and installation of all needed binaries and choice of first model.")
3. **External tools are optional, consent-gated.** Detect Ollama if installed; if it is, **ask**
   whether to use/launch it, with a Settings toggle to "always launch, don't ask again". Never
   require it, never spawn it without consent. (Dawid: "Detect ollama if it's installed. If it
   is - ask if it's ok to run it (toggle in settings to not ask again and always launch).")
4. **Self-reliant fallback everywhere.** When the configured brain is unreachable, fall back to a
   downloaded built-in embedded model (generalize the stopgap from chat to every brain call),
   with an honest note. Honest error only when there is genuinely nothing usable.
5. **A model floor for weak hardware.** Add a small model (Qwen2.5-1.5B-Instruct GGUF, ~1 GB) to
   the catalog so even a low-end laptop gets a usable built-in brain; the verdict recommends it
   on limited hardware.
6. **No auto-install of Ollama, no driver installation.** We detect + (with consent) launch what
   the user already has; we never silently install external software. The native runtime already
   ships inside the app, so "install needed binaries" = verify the bundled runtime loads + download
   the chosen model.

## Architecture (components + boundaries)

The renderer talks ONLY to main via IPC; all detection/spawn/download happens in main.

### A. First-run onboarding (renderer + main)
- **Trigger:** on app start, if no brain is configured, the shell shows an **Onboarding** view
  instead of the empty "No brain yet" state. (A dedicated first-party page, per the IA rule.)
- **Steps (one screen, progressive):**
  1. Welcome — "Let's set up your private brain. It runs on this computer; nothing leaves."
  2. Hardware — `local:status` already returns a florist-language hardware view; show it.
  3. Runtime readiness — main verifies the embedded runtime loads (`engine.detect()` on the
     embedded engine). If it can't load on this machine, say so honestly and offer cloud/Ollama.
  4. Ollama (only if detected installed) — "We found Ollama on your computer. Use it? [Use Ollama]
     [Use the built-in brain]" + persists the choice (see C).
  5. Model choice — recommend a fitting model (the existing `verdict`), show 2–3 options incl. the
     small floor; the user picks; download with the existing progress channel; sha256-gated.
  6. Done — set active brain → enter the app.
- **Re-run:** the existing "On this computer" Settings page gains a "Set up again" entry point;
  onboarding reuses the same components.

### B. Self-reliant fallback (main) — generalize the stopgap
- Replace the chat-only `routerWithSelfReliantFallback` with a shared resolver used by every
  `buildRouter` consumer (chat, `brain:test`, skills). Decision stays the pure
  `pickSelfReliantFallback` (already unit-tested): local brain unreachable + a downloaded embedded
  model present → use the embedded one; surface an honest note where the caller can show it.
- Because onboarding guarantees a downloaded embedded model exists, the fallback almost always has
  a target.

### C. Ollama detect + consent + optional auto-launch (main)
- **Detect installed:** resolve the `ollama` executable (PATH + known install locations per OS),
  shell-free. Separate from "is it running" (`engine.detect()` — the loopback ping).
- **Consent model:** a persisted setting `ollamaLaunch: "ask" | "always" | "never"` (default
  "ask"). On a local-Ollama brain call when Ollama is down:
  - `never` → skip straight to the built-in fallback.
  - `always` → spawn `ollama serve`, wait for readiness (bounded timeout), then use it; on failure
    fall back to built-in.
  - `ask` → return a state the UI surfaces ("Start Ollama? [Once] [Always] [Use built-in]"); the
    choice updates the setting and proceeds.
- **Spawn safety:** spawn the resolved binary shell-free (mirror `claude-cli` `shell:false`), no
  user input in args, as a managed child; kill on app quit. Consent-gated → satisfies the
  "no un-consented subprocess / permission layer" invariant.
- **Settings:** a toggle group for `ollamaLaunch` + an Ollama status line.

### D. Model floor (catalog)
- Add Qwen2.5-1.5B-Instruct Q4_K_M GGUF (single-file, pinned sha256) to `catalog-snapshot.json`
  and the live catalog, with a `gguf` block so it runs embedded. The `verdict` picks it on
  limited hardware.

## Data / settings model

- `userData/settings.json` (or extend the existing config) — `{ ollamaLaunch: "ask"|"always"|"never" }`.
  Main-owned; IPC to read/set. (No secret; plain JSON is fine.)
- Brain config unchanged (keychain via `keys.ts`).
- Chat/receipts unchanged — a fallback or Ollama-launched call still routes through the same
  `Router` + `fileReceiptSink` (one receipt per message; local = `local:true`).

## Testing plan (metric)

All environment inputs fixtured through `!app.isPackaged` seams (determinism gate). New seams:
- `DESKHAND_OLLAMA_INSTALLED` — force "Ollama binary detected" without a real install.
- `DESKHAND_OLLAMA_SPAWN_FAKE` — a fake `ollama serve` spawn (records the launch, flips a fake
  "running" state) so the consent→launch→use path is CI-drivable without real Ollama.
- Reuse `DESKHAND_HARDWARE`, `DESKHAND_CATALOG_URL`, `DESKHAND_MODEL_DOWNLOAD_URL`, `DESKHAND_LLAMA_FAKE`.

**App e2e (`e2e/onboarding.spec.ts` + additions):**
- **O1 first-run** — fresh userData, no brain → onboarding shows → (fixtured hardware) → pick the
  recommended model → fixture download → lands in the app with an active built-in brain; a chat
  message streams a reply. Zero external tools involved.
- **O2 fallback (generalized)** — configured local-Ollama brain, Ollama down, an embedded model
  downloaded → a chat send + "Test my brain" both use the built-in and show the honest note.
- **O3 Ollama consent** — Ollama "installed" (seam) + down + `ollamaLaunch:"ask"` → the UI offers
  to start it; choosing "Always" launches the fake spawn and persists the setting; "Use built-in"
  falls back. `never` skips the offer.
- **O4 no-runtime honesty** — embedded runtime can't load (seam) + no Ollama → onboarding offers
  cloud honestly, never a dead end.

**Units:**
- `pickSelfReliantFallback` (done), Ollama executable resolution (path parsing), the
  `ollamaLaunch` state machine (ask/always/never → action), the small-model verdict pick on
  weak hardware.

**Hand-validation (OWED — real hardware, CI can't fixture):**
- Real Ollama auto-launch on Dawid's machine (real `ollama serve`).
- A genuine fresh-machine first-run (packaged installer on a clean box → onboarding → real
  download → real GPU inference). Pairs with 029's OWED(VM).

## Security notes

- **Subprocess spawn (Ollama):** consent-gated, resolved-binary, shell-free, no user input in
  args; managed + killed on quit. Ledger `claude-cli-windows-shim` resolution technique applies.
- **Model download:** unchanged — https-only, sha256-gated, receipted, streaming (no OOM).
- **Settings file:** no secret in `settings.json`; the API key stays in the keychain.
- **Fallback:** never changes the receipt guarantee — a fallback call is still one receipt,
  `local:true`.
- **Seams:** every new `DESKHAND_*` seam is `!app.isPackaged`-gated (a packaged app can't be
  redirected), matching every existing local-brain seam.

## Out of scope

- Auto-installing Ollama or any external software; GPU driver installation.
- Cloud onboarding beyond the existing Settings brain picker.
- Multiple concurrent local models / model hot-swap UI beyond "change model in Settings".
- The in-app "live log" window (Dawid chose terminal logging; already shipped).

## Notes on size

This is a large loop (onboarding UI + settings + Ollama subprocess + catalog + generalized
fallback + 4 e2e). Dawid chose to combine deliberately. The BUILD should proceed in the phase
order A→D above, running the metric after each phase; the loop contract should set a higher
checker iteration budget (≥5) to reflect the scope.
