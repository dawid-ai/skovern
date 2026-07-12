import { app } from "electron";
import {
  ollamaEngine,
  verdict,
  type CatalogModel,
  type HardwareProfile,
  type LocalEngine,
  type LocalModelInfo,
  type PullProgress,
  type VerdictModel,
} from "@deskhand/core";
import { fileFetchSink } from "./receipts.js";
import { scanHardware } from "./hardware.js";
import { loadCatalog } from "./catalog.js";
import type {
  HardwareView,
  LocalModelsView,
  LocalModelView,
  LocalStatusView,
} from "../shared/local.js";

// The Local Brain service (TRUSTED main only): it wires the hardware scan, the
// Ollama engine (loopback), the live catalog, and the pure verdict into the plain
// views the renderer reads. The renderer makes NO network calls — everything
// on-machine or over-the-wire happens here, and the catalog fetch is receipted.

const GB = 1024 * 1024 * 1024;

// Default to loopback Ollama. An override is a dev/test seam (point at a fixture),
// honored ONLY unpackaged — mirror of DEV_SERVER_URL. The engine ALSO enforces
// loopback regardless, so this can never reach off-box even if misused.
export function ollamaBaseUrl(): string {
  const override = !app.isPackaged ? process.env["DESKHAND_OLLAMA_URL"] : undefined;
  return override && override.length > 0 ? override : "http://127.0.0.1:11434";
}

// Catalog URL override is likewise an unpackaged dev/test seam (fixture server).
function catalogUrl(): string | undefined {
  return !app.isPackaged ? process.env["DESKHAND_CATALOG_URL"] || undefined : undefined;
}

export function makeEngine(): LocalEngine {
  return ollamaEngine({ baseUrl: ollamaBaseUrl() });
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

// A pulled model may not report its parameter size; estimate from disk size so the
// verdict can still score it (Q4 ≈ 0.6 GB per billion params).
function toVerdictModel(m: { id: string; label: string; params?: number; sizeBytes?: number }): VerdictModel {
  const params = m.params ?? (m.sizeBytes ? m.sizeBytes / (0.6 * GB) : 3);
  return { id: m.id, label: m.label, params, sizeBytes: m.sizeBytes };
}

// The candidate set the verdict scores: the catalog suggestions PLUS the user's own
// pulled models (dedup'd against the catalog). BOTH `localStatus` (the headline) and
// `localModels` (the hero) MUST score this same set, or the recommendation they name
// diverges — the headline would pick the best catalog model while the hero picks a
// bigger already-installed one. Single source → they always agree.
function candidateVerdictModels(
  catalogModels: { id: string; label: string; params?: number; sizeBytes?: number }[],
  have: LocalModelInfo[],
): VerdictModel[] {
  const catalogIds = new Set(catalogModels.map((m) => m.id));
  const ownHave = have.filter((m) => !catalogIds.has(m.id));
  return [...catalogModels.map(toVerdictModel), ...ownHave.map(toVerdictModel)];
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
    scanHardware(),
    loadCatalog(fileFetchSink(), catalogUrl()),
    detectAndList(engine),
  ]);
  const v = verdict(profile, candidateVerdictModels(catalog.models, det.have));
  return {
    ollamaReady: det.ready,
    hardware: hardwareView(profile),
    verdict: v,
    notice: det.ready
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
    scanHardware(),
    loadCatalog(fileFetchSink(), catalogUrl()),
    detectAndList(engine),
  ]);

  const haveIds = new Set(det.have.map((m) => m.id));
  const catalogIds = new Set(catalog.models.map((m) => m.id));
  const ownHave = det.have.filter((m) => !catalogIds.has(m.id));

  // Same candidate set as `localStatus` — so the headline and the hero name the
  // SAME recommendation (see candidateVerdictModels).
  const v = verdict(profile, candidateVerdictModels(catalog.models, det.have));
  const tierOf = (id: string) => v.fits.find((f) => f.modelId === id);

  const suggested: LocalModelView[] = catalog.models.map((c: CatalogModel) => {
    const fit = tierOf(c.id);
    return {
      id: c.id,
      label: c.label,
      group: "suggested",
      downloaded: haveIds.has(c.id),
      tier: fit?.tier ?? "amber",
      usable: fit?.usable ?? true,
      note: fit?.note ?? "",
      recommended: v.recommendedModelId === c.id,
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
      recommended: v.recommendedModelId === m.id,
      size: m.sizeBytes ? fmtGB(m.sizeBytes) ?? undefined : undefined,
    };
  });

  const notice = !det.ready
    ? "Ollama isn't running — start it and choose \"Check my computer again\" to see your models."
    : catalog.notice ?? "";

  return { ollamaReady: det.ready, models: [...have, ...suggested], notice };
}

/** Start pulling a model, forwarding progress. Rejects (descriptively) on failure. */
export function pullModel(modelId: string, onProgress: (p: PullProgress) => void): Promise<void> {
  return makeEngine().pull(modelId, onProgress);
}
