# Spec: Local Brain Loop 2a — the embedded runtime spine (node-llama-cpp)

**Status:** draft — awaiting Dawid's review
**Date:** 2026-07-13
**Author:** brainstormed with Dawid (2026-07-13)
**Parent spec:** `docs/specs/2026-07-12-local-brain-spec.md` (the overall Local Brain design + Loop 1)
**Scope of THIS spec:** Loop 2a — the smallest slice that proves an **embedded**
(`node-llama-cpp`) private brain works end-to-end behind the proven `LocalEngine`
interface, for the **no-Ollama** florist. Loop 2b (full embedded catalog + polish) and
Loop 3 (buy/upgrade guide) stay sketched in the parent spec.

## Why 2a, and why a split

Loop 1 shipped the Local Brain spine + the **Ollama** backend: a user who already runs
Ollama gets a private brain. The core target persona — a non-technical florist who's
never heard of Ollama — still can't. The parent spec's Loop 2 closes that with an
**embedded** runtime we own (`node-llama-cpp`, prebuilt native binaries), so there's no
external app, no port, no terminal, no admin prompt.

Dawid chose to **embed node-llama-cpp** over auto-installing Ollama specifically because
it is the path that **works most uniformly across win/mac/linux**: one runtime that
behaves identically on all three (Metal on macOS, CUDA/Vulkan elsewhere, CPU fallback
everywhere), versus auto-install's three divergent, invasive installers + a background
server. Embedding also keeps the model download under **our** downloader, so the
"receipts for every byte" promise has no blind spot.

The unknown is real: **node-llama-cpp packaged inside Electron across three OSes with GPU
backends is unproven in this repo.** So Loop 2 is split. **2a proves the runtime** in the
smallest hand-validatable slice (one model, one child, our downloader). **2b** adds the
rest of the catalog and the polish. This spec is 2a.

## Goal (2a)

A no-Ollama user opens the existing local-brain setup view, clicks **"Get this one"** on
**Qwen2.5-3B-Instruct (Q4)**, watches it download, clicks **"Use this one,"** and a real
skill runs on a private brain — with the Receipts page showing the download coming **in**
(from Hugging Face) and the generate **staying on the machine** ("stayed on your
computer"). No Ollama installed, no terminal, one click.

## Architecture

### The `LocalEngine` contract is unchanged
Loop 1's interface (`packages/core/src/local/types.ts`) already models exactly what a
second backend needs: `detect() / listModels() / generate() / pull()`. 2a adds a **second
implementation**, not a new interface. The router and skills never learn which backend
runs.

### Where the code lives (and why it's NOT in core)
The Ollama backend lives in `packages/core` because it's pure HTTP — no native dep, runs
in CI without Electron. The embedded backend **cannot**: it needs the native `node-llama-cpp`
addon and a forked child. So **`llamaEngine` lives in `apps/desktop/src/main/`** (beside
`claude-cli.ts` / `plugin-host.ts`), implementing the core interface. The interface is the
contract; implementation location follows the dependency. `packages/core` stays native-free.

### Process model: a forked, crash-isolated child
Inference runs in a **child process** forked the way the plugin host forks (the shipped
Electron binary re-executed with `ELECTRON_RUN_AS_NODE`, per the 012b finding that
`utilityProcess` doesn't enforce the Permission Model). Rationale:

- A native LLM crash (a segfault in llama.cpp) is **not catchable** by a JS `try/catch`.
  In-process, it takes down all of Electron main — the exact "a subprocess error crashes
  the whole app" class we hotfixed for `claude-cli` (`2271730`). A child **contains** it.
- The child loads the GGUF **once and stays warm** for its lifetime; `generate` sends a
  prompt over IPC and receives `{ text, tokensIn, tokensOut }`. node-llama-cpp reports
  token counts, so the private-brain receipt keeps showing "X tokens in, Y out — all on
  your computer" (the 022 shape).
- **Every** child failure — spawn failure, load failure, inference error, silence past an
  idle timeout, abnormal exit — funnels into a **specific, plain-language rejection**
  (mirror `collectOutput`): a private brain can never crash its host.
- Lifecycle: spawned lazily on first `generate`, killed on app quit and on model switch.
  One warm child for 2a's single model.

### Router dispatch
The `local` provider in `main/index.ts` gets a tiny dispatcher: a chosen model that has a
catalog **`gguf`** block routes to `llamaEngine`; an Ollama-native model routes to
`ollamaEngine`. For 2a there is exactly one embedded model, so the dispatch is trivial —
but it's the seam Loop 2b widens.

## The downloader (`downloadModel`, main)

The no-Ollama user has no Ollama `pull` server, so we fetch the GGUF ourselves. This is a
**streaming, self-receipting** download — deliberately NOT built on `receiptedFetch`:

1. **Fail-closed egress receipt first.** Write a durable `"sent"` `FetchReceipt`
   (`kind:"fetch"`, `host:"huggingface.co"`, `direction:"in"`, `task:"Downloading
   Qwen2.5-3B"`) **before any byte leaves** — same discipline as every other egress. If
   the receipt sink throws, the download never starts.
2. **Stream to disk, hashing on the fly.** Fetch and pipe the body to
   `userData/models/<filename>.gguf`, updating a `crypto` sha256 **and** a running byte
   counter as chunks arrive. `receiptedFetch` is unusable here: it does
   `res.clone().arrayBuffer()` to count bytes (the `receipts-response-buffering` ledger
   item), which would buffer the whole **2 GB** body in main and OOM it. Streaming to disk
   sidesteps that by design and gives progress for free.
3. **sha256 gate (the security-critical step).** After the stream completes, compare the
   computed hash to the catalog's expected `sha256`. **On mismatch: delete the partial/bad
   file and reject** with a descriptive error — a corrupted or attacker-substituted weight
   file is **never loaded** into the native runtime. On match: the file is the model.
4. **`"done"` receipt** with the real byte count and outcome.
5. Progress is surfaced to the UI through the existing `PullProgress` shape, so the setup
   view's progress bar (built for Ollama pulls in Loop 1) is reused unchanged.

Download resume across restarts is **out of scope → 2b** (`ponytail:` a re-click restarts
the fetch; acceptable for a runtime proof; add `ipull`/range-resume in 2b if the 2 GB
restart hurts).

## Catalog schema

Extend `CatalogModel` (`packages/core/src/local/types.ts`) with an **optional** block:

```ts
/** Present only for models we can run with the embedded runtime. Absent = Ollama-only.
 *  Untrusted network input (fetched from the catalog) — validated on load. */
gguf?: {
  url: string;        // https-only direct GGUF URL (Hugging Face)
  sha256: string;     // lowercase hex, 64 chars — the integrity gate
  sizeBytes: number;  // expected download size (for the progress bar + a disk check)
  filename: string;   // local filename; validated charset, no path separators
  contextSize: number;// context window to allocate in the child (e.g. 4096)
};
```

One catalog, one source of truth, same live-fetch + bundled-snapshot + receipt + descriptive-
error path as Loop 1. For 2a only the Qwen2.5-3B entry carries a `gguf` block. Validation
(untrusted input): `url` must be `https:`; `sha256` must match `/^[0-9a-f]{64}$/`;
`sizeBytes`/`contextSize` finite positive; `filename` restricted to a safe charset with **no
path separators or `..`** (closes the `local-catalog-id-charset` trigger — see ledger).

## The chosen model

**Qwen2.5-3B-Instruct, Q4_K_M GGUF (~2 GB, Apache-2.0).** Best quality-per-size for a small
model; runs CPU-only on a typical florist laptop (slower — the verdict engine already
downgrades 3B-on-CPU to "runs, but slow" honestly) and fast on any GPU. Permissive license
for the transparency card. (Fallback if it proves too heavy for common hardware in hand-
validation: Llama-3.2-1B-Instruct Q4, ~0.8 GB.)

## UX / IA

**No new screen.** The Loop 1 local-brain setup view already renders catalog suggestions
with fit dots, per-model transparency, a "Get this one" action, and a pull progress bar.
2a wires the **embedded path behind the existing controls**: when the chosen suggestion is
the embedded Qwen and Ollama is absent, "Get this one" calls **our** `downloadModel`
(same progress bar), and "Use this one" runs it on the llama child. The no-Ollama user sees
the same, already-designed screen — and now it works without Ollama.

**Receipts:** the download is an **In ↓** egress receipt (`huggingface.co`); the generate is
a `local` on-machine call → **"stayed on your computer"** with token counts (unchanged from
Loop 1's local-receipt handling).

## Metric — CI proves the fixturable, Dawid proves the native

A 2 GB native LLM cannot run in CI, so per the determinism gate the **real inference is
hand-validation, not the CI metric.** Everything else is fixtured and deterministic.

### Units (deterministic, machine-independent)
- **Downloader** (fixture HTTP server, temp `userData`): writes the `"sent"` receipt
  **before** the first byte; forwards progress; on a body whose bytes hash to the expected
  value, writes the file and a `"done"` receipt; **on a hash MISMATCH, deletes the file and
  rejects with a specific reason** (negative, security-critical); streams a body larger than
  one buffer to disk **without** buffering it whole (guards the OOM path).
- **Catalog `gguf`-block validation** (untrusted input): rejects non-https `url`, a
  non-64-hex `sha256`, a `filename` containing a path separator or `..`, non-positive sizes
  — each with the specific reason (no bare throws).
- **`llamaEngine` over a FAKE child** (mirror `claude-cli.test`'s fake-child pattern):
  `generate` sends the prompt and parses `{text, tokensIn, tokensOut}`; a child that errors,
  stalls past the idle timeout, or exits abnormally becomes a **descriptive rejection** —
  never an async throw that crashes the host. No native addon loaded in this test.
- **Router dispatch:** a model with a `gguf` block resolves to the llama engine; an
  Ollama-native model resolves to the Ollama engine.
- **`router-onmachine-token-trust` guard:** the router re-validates `tokensIn/tokensOut`
  from the (now second) on-machine engine with a `countOf`-equivalent before stamping them
  on a receipt (a non-integer can't reach the receipt).

### App e2e (real Electron UI, fixtured backend + fixture download server)
Settings → "On this computer" → the embedded Qwen suggestion → "Get this one" shows a
progress bar → completes → "Use this one" → run a skill → the **Receipts** page shows a
**Hugging Face download (In ↓)** and a **"stayed on your computer"** generate. The native
engine is swapped for a fake via a dev/test seam (mirror `DESKHAND_CLAUDE_BIN` /
`DESKHAND_OLLAMA_URL`), and the download server is a fixture — so PASS/FAIL is a pure
function of the diff, not the CI runner's hardware or network.

### Hand-validation (Dawid — this loop's METRICS row will be `OWED`)
On a real machine: the real Qwen2.5-3B GGUF downloads (real progress + real sha256 pass),
the **real node-llama-cpp child** loads and runs a real skill, and the receipt reads
"stayed on your computer." Confirms the native packaging actually works. One OWED row (under
the 3-row debt cap). Flip to a date when Dawid signs off.

## Security notes (for the reviewer — testable ones become metric clauses)

- **sha256 integrity gate (testable → metric).** A model file whose hash doesn't match the
  catalog is **deleted and never loaded**. This is the load-bearing defense: it stops a
  corrupted download and an attacker who substitutes a weight file (e.g. a poisoned mirror
  or a MITM without pinning) from ever reaching the native runtime. Negative-tested with the
  specific rejection reason.
- **Download egress is receipted, fail-closed, and streaming (testable → metric).** The
  `"sent"` receipt is durable before any byte leaves; the body streams to disk so a 2 GB
  model can't OOM main (sidesteps `receipts-response-buffering`).
- **https-only, host-sane download URL (testable → metric via catalog validation).** The
  `gguf.url` must be `https:`. The URL comes from our own (public-repo) catalog, but it's
  network-fetched → untrusted; validate its shape. Redirect handling: prefer `redirect:
  "error"` or re-validate the final host stays https (mirror the `plugin-fetchurl-ssrf`
  posture) so a redirect can't divert the download off to an arbitrary host. (If full
  redirect-pinning is deferred, say so — but https-only + the sha256 gate together mean a
  diverted download still can't produce a file that loads.)
- **No path traversal from catalog data (testable → metric).** The model filename comes
  from the catalog; it's restricted to a safe charset with no separators / `..` before it
  becomes a path under `userData/models/` (closes `local-catalog-id-charset`).
- **The child can never crash the host (testable → metric).** Every failure mode is a
  descriptive rejection (the `collectOutput` discipline). The child is crash-isolated by
  being a separate process.
- **Untrusted model output** is the same untrusted text as any brain — it flows through the
  existing render/markdown escaping unchanged.
- **Native packaging (deferred, flagged NOT skipped).** node-llama-cpp ships a native
  `.node` that (like `@resvg/resvg-js`, `systeminformation`) must be `asarUnpack`'d and the
  correct per-platform binary shipped in a packaged build. 2a hand-validates via `dev` (not
  a packaged build), so real `electron-builder` packaging stays a deferred ledger item —
  named, not silently skipped. The engine's `detect()` failing to load the addon on a
  platform degrades to an honest "the private brain isn't available on this computer yet,"
  never a crash.

## Ledger triage (items whose trigger 2a meets)

| ledger item | trigger met? | pulled in / deferred |
|-------------|--------------|----------------------|
| `local-catalog-id-charset` | **met** — a catalog string becomes a **file path** in 2a (its exact trigger) | **Pulled in.** Validate `gguf.filename` charset, no separators/`..`. |
| `local-pull-stream-buffer-cap` | **met** — we now stream a large body ourselves | **Pulled in.** Downloader streams to disk with a byte cap posture; never buffers whole. |
| `router-onmachine-token-trust` | **met** — a **second** on-machine engine lands | **Pulled in.** `countOf` guard at the router boundary. |
| `receipts-response-buffering` | met (a large-body egress path appears) | **Addressed by design** — the downloader streams instead of `res.clone().arrayBuffer()`; it does not use `receiptedFetch`. The first-party-JSON path that item names is unchanged. |
| `resvg-native-packaging` / `systeminformation-packaging` | partial — 2a adds a THIRD native module | **Deferred (packaging loop).** 2a hand-validates via `dev`; real packaged-build validation across all 3 OSes rides with the eventual electron-builder loop. Flagged. |
| `plugin-fetchurl-ssrf` | tangential — a new outbound fetch (download) appears | **Not the plugin path.** The download is first-party to our catalog's https URL; apply https-only + (prefer) redirect:"error". Full DNS-rebind pinning stays with the plugin-fetch item. |

## Out of scope → Loop 2b (and beyond)

- The **rest of the embedded catalog** (more than one `gguf` model) + choosing among them.
- The full **per-model transparency download flow** polish (2a reuses the existing card).
- **Download resume** across restarts / app close.
- **Keep-warm / idle-unload** tuning of the child (2a: warm for the child's life, killed on
  quit/switch).
- **Packaged-build validation** on win/mac/linux (electron-builder) — the native-packaging
  ledger loop.
- Exhaustive multi-GPU enumeration polish (parent spec, still Loop-1-deferred).

## Open question for Dawid at review

- The forked-child process model (more moving parts than in-process) — confirmed for
  crash-safety. OK?
- Accepting **one `OWED` hand-validation row** (a real native LLM can't run in CI). OK?
