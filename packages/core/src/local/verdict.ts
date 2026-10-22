import { fit, specFor, type FitModel, type FitResult } from "@dawid-ai/model-fit";
import type { FitTier, HardwareProfile, ModelFit, Verdict, VerdictModel } from "./types.js";

// The honesty engine: hardware profile + candidate models → an honest, warm verdict. Pure and
// deterministic (no I/O). The MATH (memory need, share of the machine, words-per-second) lives in
// @dawid-ai/model-fit; this file keeps Skovern's own rules and its florist words. It judges
// USABLE, not merely "runs":
//   - green  = a GPU we can use holds the whole model with room to spare. Its label says whether
//              it's also quick ("Runs great here") or big and steady ("Fits here").
//   - amber  = it runs, but slowly (CPU-only, partly offloaded to RAM) or only just fits.
//   - red    = it won't fit at all, or would crawl on the processor — no false hope.
// A recommendation, never a gate: the UI still lets the user run an amber pick, with the
// trade-off spelled out.

const GB = 1024 * 1024 * 1024;

// Below this, a "GPU" is really an iGPU too small to accelerate a useful model — treat the
// machine as CPU-only rather than promise acceleration it can't give.
const MIN_USEFUL_VRAM = 2 * GB;
// Unified memory (Apple Silicon, AMD Ryzen AI Max, NVIDIA GB10) is shared with the OS and your
// apps; only part is usable for a model. Exported so the hardware scan can tell whether a chip's
// shared pool beats its own carve-out.
// ponytail: a constant until Loop B reads the real limit (Metal's working set, AMD's shared-memory
// cap, which is closer to half on Windows and Linux).
export const UNIFIED_USABLE = 0.66;
// A model with more params than this on CPU-only is "painfully slow" territory.
const CPU_SLOW_PARAMS = 7;
// "Good" = capable enough to be worth running locally at all.
const GOOD_PARAMS = 3;
// The context window our runtimes allocate (the catalog's `contextSize`).
const CONTEXT = 4096;
// Below this a brain's WORDS call it slow or steady, wherever it runs (Dawid, 2026-10-07 and -10).
// It never changes a tier, and it never swings a good pick (green, GOOD_PARAMS or more): speeds are
// estimates. Only the fallback pick reads it, to prefer a capable brain that isn't slow. It is exactly the speed
// the app shows as "about 10 words a second" (speed-words.ts: 0.75 words per token, rounded), so
// "about 9" always reads slow and "about 10" never does.
const QUICK_TOKPS = 9.5 / 0.75;

/** The model as the fit math sees it: its own catalog numbers, plus the architecture the shared
 *  module knows for its id (an Ollama tag), when it knows it. */
function fitModelOf(m: VerdictModel): FitModel {
  const spec = specFor(m.id);
  return {
    params: m.params,
    quant: m.quant,
    ...(m.sizeBytes !== undefined ? { sizeBytes: m.sizeBytes } : {}),
    ...(spec ? { layers: spec.layers, kvHeads: spec.kvHeads, headDim: spec.headDim, kind: spec.kind } : {}),
    // ponytail: an Ollama model with "embed" in its name turns text into numbers and never writes,
    // so it gets no words-per-second. Read the real kind from Ollama's model info if this misfires.
    ...(!spec && /embed/i.test(m.id) ? { kind: "embedding" as const } : {}),
  };
}

/** Run the shared fit math with Skovern's stricter rules. Exported so a caller showing a model's
 *  speed reads the SAME numbers its tier came from (one source of truth). */
export function fitFor(profile: HardwareProfile, m: VerdictModel): FitResult {
  return fit(profile, fitModelOf(m), { ctx: CONTEXT, unifiedUsable: UNIFIED_USABLE, minUsefulVramBytes: MIN_USEFUL_VRAM });
}

function memoryUnknown(profile: HardwareProfile): boolean {
  const vram = profile.unifiedMemory ? 0 : profile.bestVramBytes ?? 0;
  return (profile.ramBytes ?? 0) <= 0 && vram < MIN_USEFUL_VRAM;
}

function fitOne(profile: HardwareProfile, m: VerdictModel): ModelFit {
  const r = fitFor(profile, m);
  const unknownMem = memoryUnknown(profile);
  const writes = fitModelOf(m).kind !== "embedding";
  const tooSlowOnCpu = r.runMode === "cpu" && m.params > CPU_SLOW_PARAMS;
  // A speed is shown only for a model that will actually run here — never for red, never a guess
  // when memory or the model's size is unknown.
  const tokPerSec = r.runMode !== "none" && !tooSlowOnCpu && !unknownMem && !m.paramsGuessed ? r.tokPerSec : null;
  // "Slow" is judged on the speed we SHOW, so the label never contradicts the line under it. No
  // speed → no speed claim either way.
  const slow = tokPerSec !== null && tokPerSec < QUICK_TOKPS;
  const amber = (label: string, note: string) => ({ tier: "amber" as const, label, note });

  let f: { tier: FitTier; label: string; note: string };
  if (unknownMem) {
    // We couldn't read memory at all — be honest, don't guess a pass.
    f = amber("We couldn't check", "This computer didn't tell us how much memory it has, so we're not sure how well it'll run.");
  } else if (r.runMode === "gpu") {
    // A unified-memory machine (a Mac, a Ryzen AI Max, a GB10) has no separate graphics card — its
    // brain runs in the computer's shared memory.
    const where = profile.unifiedMemory ? "in this computer's memory" : "on your graphics card";
    if (r.level === "marginal") {
      const mem = profile.unifiedMemory ? "this computer's memory" : "your graphics card's memory";
      f = amber("Only just fits", `Uses nearly all of ${mem} — it may crowd your other apps${slow ? ", and it'll write slowly" : ""}.`);
    } else if (slow) {
      // Green is "fits with room", so the pick stays a memory judgment; the words just never
      // promise quick (Dawid, 2026-10-10).
      f = { tier: "green", label: "Fits here", note: `Room for it ${where} — big, so it writes at a steady pace.` };
    } else if (tokPerSec === null && writes) {
      f = { tier: "green", label: "Fits here", note: `Room for it ${where}. We don't know this brain's size, so we can't say how fast.` };
    } else if (!writes) {
      f = { tier: "green", label: "Runs great here", note: `Fits ${where} — fine for this helper brain, which doesn't write replies.` };
    } else {
      f = { tier: "green", label: "Runs great here", note: `Fits ${where} — this one will feel quick.` };
    }
  } else if (r.runMode === "partial") {
    f = slow
      ? amber("Runs, but slowly", "Bigger than your graphics memory — part runs on the processor, so it'll be slower.")
      : amber(
          "Partly on your processor",
          tokPerSec === null && writes
            ? "Bigger than your graphics memory, so part runs on the processor. We don't know this brain's size, so we can't say how fast."
            : "Bigger than your graphics memory, so part runs on the processor — still quick enough.",
        );
  } else if (r.runMode === "cpu" && !tooSlowOnCpu) {
    f = slow
      ? amber("Runs, but slowly", "Runs on your processor (no graphics card we can use) — it'll work, but slowly.")
      : amber(
          "Runs on your processor",
          !writes
            ? "No graphics card we can use — fine for this helper brain, which doesn't write replies."
            : tokPerSec === null
              ? "No graphics card we can use. We don't know this brain's size, so we can't say how fast it'll be."
              : "No graphics card we can use, but a small brain like this keeps up fine.",
        );
  } else if (tooSlowOnCpu) {
    f = { tier: "red", label: "Too big for this computer", note: "Would run on your processor only, and be painfully slow at this size." };
  } else {
    const card = profile.unifiedMemory || (profile.bestVramBytes ?? 0) >= MIN_USEFUL_VRAM;
    f = {
      tier: "red",
      label: "Too big for this computer",
      note: card ? "It needs more memory than this computer can spare — it won't run well here." : "It needs more memory than this computer has — it won't run here.",
    };
  }
  return { modelId: m.id, tier: f.tier, usable: f.tier !== "red", label: f.label, note: f.note, tokPerSec };
}
/** Score every candidate model against a machine and return one warm verdict. */
export function verdict(profile: HardwareProfile, models: VerdictModel[]): Verdict {
  const fits = models.map((m) => fitOne(profile, m));

  // The recommendation only ever names a model the user can ACTUALLY get right now
  // (`fetchable !== false`) — recommending one with a dead download button is a bug.
  // The fit table above still scores EVERY model, fetchable or not, so the user sees how
  // each fits; only the pick is constrained. (Unset fetchable → true → unchanged.)
  const scored = models.map((m, i) => ({ m, fit: fits[i]! }));
  const gettable = scored.filter((x) => x.m.fetchable !== false);

  // A model is "good enough to steer someone to" when it's fast (green) AND
  // capable (>= GOOD_PARAMS). The biggest such GETTABLE model wins.
  const goodGreens = gettable
    .filter((x) => x.fit.tier === "green" && x.m.params >= GOOD_PARAMS)
    .sort((a, b2) => b2.m.params - a.m.params);
  const canRunGoodOne = goodGreens.length > 0;

  let recommendedModelId: string | null = null;
  let headline: string;

  if (canRunGoodOne) {
    recommendedModelId = goodGreens[0]!.m.id;
    headline = `Good news — this computer can run a real private brain. Our pick for it: ${goodGreens[0]!.m.label}.`;
  } else {
    // No fast, capable, gettable option. Steer to the best gettable brain that runs, and be honest
    // that the cloud brain will feel better. A brain that doesn't write (embedding) is never the
    // pick. "Best" = the biggest CAPABLE one (GOOD_PARAMS or more) that isn't slow, so a 7B at 15
    // words a second beats a 14B at 7 (Dawid, 2026-10-10). When every capable one is slow, the
    // fastest of them, so a CPU-only box gets the 3B at ~7 words a second, not the 7B at ~3, and
    // never drops below 3B for speed (L1, 2026-10-20). Only when no capable brain runs, the
    // biggest that does. No speed counts as not slow only when memory is unknown (all tie on
    // size); a guessed-size brain with no speed isn't promised quick and ranks last on speed.
    const unknownMem = memoryUnknown(profile);
    const notSlow = (x: (typeof scored)[number]) =>
      x.fit.tokPerSec === null ? unknownMem : x.fit.tokPerSec >= QUICK_TOKPS;
    const usable = gettable
      .filter((x) => x.fit.usable && fitModelOf(x.m).kind !== "embedding")
      .sort((a, b2) => b2.m.params - a.m.params);
    const capable = usable.filter((x) => x.m.params >= GOOD_PARAMS);
    const fastest = [...capable].sort((a, b2) => (b2.fit.tokPerSec ?? -1) - (a.fit.tokPerSec ?? -1))[0];
    // N7 (2026-10-21): with memory unknown nothing has a speed, so "biggest" would hand an unread
    // machine a 9 GB brain. Start it on the smallest capable brain instead.
    const start = unknownMem
      ? (capable[capable.length - 1] ?? usable[0])
      : (capable.find(notSlow) ?? fastest ?? usable[0]);
    if (start) {
      recommendedModelId = start.m.id;
      // L2 (2026-10-21): the headline says "slow" only when the pick's own row does.
      const lead = unknownMem
        ? "We couldn't check this computer's memory, so we'd start small"
        : notSlow(start)
          ? start.m.params >= GOOD_PARAMS
            ? "This computer can run a private brain, but it's a tight fit"
            : "This computer can run a smaller private brain"
          : "This computer can run a private brain, but it'll feel slow";
      headline =
        `${lead} — the free cloud brain or your subscription will likely serve you better. ` +
        `If you'd still like to try it here, start with ${start.m.label}.`;
    } else {
      headline =
        "This computer can't comfortably run a private brain yet — the free cloud brain or your subscription will serve you much better.";
    }
  }

  return { fits, recommendedModelId, canRunGoodOne, headline };
}
