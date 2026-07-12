import type { FitTier, HardwareProfile, ModelFit, Verdict, VerdictModel } from "./types.js";

// The honesty engine: hardware profile + candidate models → an honest, warm
// verdict. Pure and deterministic (no I/O), so it's the testable backbone of the
// whole feature. It judges USABLE, not merely "runs":
//   - green  = a GPU we can use holds the whole model → fast.
//   - amber  = it runs, but slowly (CPU-only, or partly offloaded to RAM).
//   - red    = it won't fit at all — no false hope.
// A recommendation, never a gate: the UI still lets the user run an amber pick,
// with the trade-off spelled out.

const GB = 1024 * 1024 * 1024;

// A model needs headroom above its raw footprint (runtime, other apps).
const HEADROOM = 1.2;
// Below this, a "GPU" is really an iGPU too small to accelerate a useful model —
// treat the machine as CPU-only rather than promise acceleration it can't give.
const MIN_USEFUL_VRAM = 2 * GB;
// A model with more params than this on CPU-only is "painfully slow" territory.
const CPU_SLOW_PARAMS = 7;
// Unified memory (Apple) is shared with the OS; only part is usable for a model.
const UNIFIED_USABLE = 0.66;
// "Good" = capable enough to be worth running locally at all.
const GOOD_PARAMS = 3;

// Rough on-disk weight size when the catalog doesn't give one: ~0.6 GB per billion
// params at Q4. An estimate, and labeled as such upstream.
function weightBytes(m: VerdictModel): number {
  return m.sizeBytes ?? m.params * 0.6 * GB;
}

// Rough KV-cache cost for a real 4k context: ~0.15 GB per billion params. Honest
// ballpark — the point is to reserve room, not to be exact.
function kvBytes(m: VerdictModel): number {
  return m.params * 0.15 * GB;
}

function footprint(m: VerdictModel): number {
  return (weightBytes(m) + kvBytes(m)) * HEADROOM;
}

interface Budget {
  /** GPU memory we can actually use for a model, 0 when CPU-only. */
  vram: number;
  /** Total memory a model could spill into (VRAM + RAM, or just RAM on CPU). */
  total: number;
  gpuAccelerated: boolean;
}

function budgetOf(profile: HardwareProfile): Budget {
  const ram = profile.ramBytes ?? 0;
  if (profile.unifiedMemory && ram > 0) {
    const usable = ram * UNIFIED_USABLE;
    return { vram: usable, total: usable, gpuAccelerated: true };
  }
  const vram = profile.bestVramBytes ?? 0;
  if (vram >= MIN_USEFUL_VRAM) {
    // A discrete GPU can offload the overflow to RAM (slower), so `total` adds RAM.
    return { vram, total: vram + ram, gpuAccelerated: true };
  }
  // CPU-only: RAM is the whole budget, nothing is fast.
  return { vram: 0, total: ram, gpuAccelerated: false };
}

function fitOne(m: VerdictModel, b: Budget): ModelFit {
  const need = footprint(m);
  let tier: FitTier;
  let note: string;

  if (b.total <= 0) {
    // We couldn't read memory at all — be honest, don't guess a pass.
    tier = "amber";
    note = "We couldn't check this computer's memory, so we're not sure how well it'll run.";
  } else if (b.gpuAccelerated && need <= b.vram) {
    tier = "green";
    note = "Fits on your graphics card — this one will feel quick.";
  } else if (!b.gpuAccelerated) {
    // CPU-only: it can run if it fits RAM, but never fast.
    if (need > b.total) {
      tier = "red";
      note = "Too big for this computer's memory — it won't run here.";
    } else if (m.params > CPU_SLOW_PARAMS) {
      tier = "red";
      note = "Would run on your processor only, and be painfully slow at this size.";
    } else {
      tier = "amber";
      note = "Runs on your processor (no graphics card we can use) — it'll work, but slowly.";
    }
  } else {
    // GPU-accelerated but bigger than VRAM: partial offload to RAM = slow, or won't fit.
    if (need <= b.total) {
      tier = "amber";
      note = "Bigger than your graphics memory — part runs on the processor, so it'll be slower.";
    } else {
      tier = "red";
      note = "Too big for this computer — it won't run well here.";
    }
  }

  return { modelId: m.id, tier, usable: tier !== "red", note };
}

/** Score every candidate model against a machine and return one warm verdict. */
export function verdict(profile: HardwareProfile, models: VerdictModel[]): Verdict {
  const b = budgetOf(profile);
  const fits = models.map((m) => fitOne(m, b));

  // A model is "good enough to steer someone to" when it's fast (green) AND
  // capable (>= GOOD_PARAMS). The biggest such model wins.
  const goodGreens = models
    .map((m, i) => ({ m, fit: fits[i]! }))
    .filter((x) => x.fit.tier === "green" && x.m.params >= GOOD_PARAMS)
    .sort((a, b2) => b2.m.params - a.m.params);
  const canRunGoodOne = goodGreens.length > 0;

  let recommendedModelId: string | null = null;
  let headline: string;

  if (canRunGoodOne) {
    recommendedModelId = goodGreens[0]!.m.id;
    headline = `Good news — this computer can run a real private brain. Our pick for it: ${goodGreens[0]!.m.label}.`;
  } else {
    // No fast, capable option. Steer to the best amber (runs, slowly) if there is
    // one, and be honest that the cloud brain will feel better.
    const usable = models
      .map((m, i) => ({ m, fit: fits[i]! }))
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
