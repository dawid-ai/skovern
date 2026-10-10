import { fit, specFor, type FitModel, type FitResult } from "@dawid-ai/model-fit";
import type { FitTier, HardwareProfile, ModelFit, Verdict, VerdictModel } from "./types.js";

// The honesty engine: hardware profile + candidate models → an honest, warm verdict. Pure and
// deterministic (no I/O). The MATH (memory need, share of the machine, words-per-second) lives in
// @dawid-ai/model-fit; this file keeps Skovern's own rules and its florist words. It judges
// USABLE, not merely "runs":
//   - green  = a GPU we can use holds the whole model with room to spare → fast.
//   - amber  = it runs, but slowly (CPU-only, partly offloaded to RAM) or only just fits.
//   - red    = it won't fit at all, or would crawl on the processor — no false hope.
// A recommendation, never a gate: the UI still lets the user run an amber pick, with the
// trade-off spelled out.

const GB = 1024 * 1024 * 1024;

// Below this, a "GPU" is really an iGPU too small to accelerate a useful model — treat the
// machine as CPU-only rather than promise acceleration it can't give.
const MIN_USEFUL_VRAM = 2 * GB;
// Unified memory (Apple) is shared with the OS and your apps; only part is usable for a model.
// ponytail: a constant until Loop B reads Metal's real working-set limit.
const UNIFIED_USABLE = 0.66;
// A model with more params than this on CPU-only is "painfully slow" territory.
const CPU_SLOW_PARAMS = 7;
// "Good" = capable enough to be worth running locally at all.
const GOOD_PARAMS = 3;
// The context window our runtimes allocate (the catalog's `contextSize`).
const CONTEXT = 4096;
// A brain on the processor (wholly or partly) at or above this speed (~10 words a second) isn't
// "slow" — it reads fine, so its label says where it runs instead (Dawid, 2026-10-07 and -10).
const QUICK_TOKPS = 13;

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
  let tier: FitTier;
  let note: string;
  const r = fitFor(profile, m);

  if (memoryUnknown(profile)) {
    // We couldn't read memory at all — be honest, don't guess a pass.
    tier = "amber";
    note = "We couldn't read this computer's memory, so we're not sure how well it'll run.";
  } else if (r.runMode === "gpu") {
    // A Mac has no separate graphics card — its brain runs in the computer's shared memory.
    const where = profile.unifiedMemory ? "in this computer's memory" : "on your graphics card";
    if (r.level === "marginal") {
      tier = "amber";
      note = `Uses nearly all of ${profile.unifiedMemory ? "this computer's memory" : "your graphics card's memory"} — it may crowd your other apps.`;
    } else {
      tier = "green";
      note = `Fits ${where} — this one will feel quick.`;
    }
  } else if (r.runMode === "partial") {
    tier = "amber";
    note = "Bigger than your graphics memory — part runs on the processor, so it'll be slower.";
  } else if (r.runMode === "cpu") {
    if (m.params > CPU_SLOW_PARAMS) {
      tier = "red";
      note = "Would run on your processor only, and be painfully slow at this size.";
    } else {
      tier = "amber";
      note = "Runs on your processor (no graphics card we can use) — it'll work, but slowly.";
    }
  } else {
    tier = "red";
    note =
      profile.unifiedMemory || (profile.bestVramBytes ?? 0) >= MIN_USEFUL_VRAM
        ? "Too big for this computer — it won't run well here."
        : "Too big for this computer's memory — it won't run here.";
  }

  // A speed is shown only for a model that will actually run here — never for red, never a guess
  // when memory is unknown.
  const tokPerSec = tier !== "red" && !memoryUnknown(profile) && !m.paramsGuessed ? r.tokPerSec : null;

  // The short label next to the dot. Amber says WHY, so it never contradicts the speed under it:
  // a brain that's on the processor (wholly or partly) but quick, or one that never writes
  // (embedding), isn't called slow.
  const offCard = tier === "amber" && !memoryUnknown(profile) && (r.runMode === "cpu" || r.runMode === "partial");
  const notSlow = offCard && (fitModelOf(m).kind === "embedding" || (tokPerSec !== null && tokPerSec >= QUICK_TOKPS));
  if (notSlow) {
    note =
      r.runMode === "partial"
        ? "Bigger than your graphics memory, so part runs on the processor — still quick enough."
        : fitModelOf(m).kind === "embedding"
          ? "No graphics card we can use — fine for this helper brain, which doesn't write replies."
          : "No graphics card we can use, but a small brain like this keeps up fine.";
  }
  const label =
    tier === "green"
      ? "Runs great here"
      : tier === "red"
        ? "Too big for this computer"
        : memoryUnknown(profile)
          ? "We couldn't check"
          : r.runMode === "gpu"
            ? "Only just fits"
            : notSlow
              ? r.runMode === "partial"
                ? "Partly on your processor"
                : "Runs on your processor"
              : "Runs, but slowly";
  return { modelId: m.id, tier, usable: tier !== "red", label, note, tokPerSec };
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
    // No fast, capable, gettable option. Steer to the best gettable amber (runs, slowly)
    // if there is one, and be honest that the cloud brain will feel better.
    const usable = gettable
      .filter((x) => x.fit.usable)
      .sort((a, b2) => b2.m.params - a.m.params);
    if (usable.length > 0) {
      recommendedModelId = usable[0]!.m.id;
      headline =
        "This computer can run a private brain, but it'll feel slow — the free cloud brain or your subscription will likely serve you better. " +
        `If you'd still like to try it here, start with ${usable[0]!.m.label}.`;
    } else {
      headline =
        "This computer can't comfortably run a private brain yet — the free cloud brain or your subscription will serve you much better.";
    }
  }

  return { fits, recommendedModelId, canRunGoodOne, headline };
}
