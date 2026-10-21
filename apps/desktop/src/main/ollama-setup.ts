import type { FetchSink, LocalEngine, PullProgress } from "@skovern/core";
import { DownloadError, ensureDiskSpace } from "./download.js";
import { installManagedOllama, ollamaDist } from "./ollama-dist.js";
import type { SetupPhase } from "../shared/local.js";

// Loop 047: "set up the helper, then get the brain" — and the receipt for a brain Ollama
// downloads itself. Kept out of `local.ts` (already over the module-size smell).

// Ollama downloads brains from its registry (the files redirect to a Cloudflare storage host);
// the receipt names the registry and says so in its label.
const REGISTRY_HOST = "registry.ollama.ai";

/** Messages Skovern wrote itself (core's own wording) pass through; anything carrying Ollama's raw
 *  text is replaced by a plain one (closes `ollama-pull-raw-error-text`). */
export function plainPullMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : "";
  if (/no space left|not enough space|disk full/i.test(msg)) {
    return "There isn't enough free space on this computer for this brain. Free up some room and try again.";
  }
  if (msg.startsWith("Ollama couldn't get that model:")) {
    if (/not exist|not found|manifest unknown/i.test(msg)) return "We couldn't find that brain. Check its name and try again.";
    return "The brain download stopped. Try again — it picks up where it left off.";
  }
  if (msg.startsWith("Ollama isn't running on this computer")) return "Ollama isn't running on this computer — start it and try again.";
  if (msg.startsWith("The download stalled") || msg.startsWith("Ollama couldn't start the download (") || msg.startsWith("Ollama didn't send any download progress")) {
    return msg;
  }
  return "The brain download stopped. Try again — it picks up where it left off.";
}

/** Pull a brain through Ollama with a receipt around it: a durable "sent" BEFORE `/api/pull` is
 *  called (if it can't be written, nothing is pulled), and a "done" with the bytes Ollama reported.
 *  Errors come back in plain words. */
export async function receiptedOllamaPull(
  engine: LocalEngine,
  modelId: string,
  onProgress: (p: PullProgress) => void,
  sink: FetchSink,
): Promise<void> {
  const base = { kind: "fetch" as const, host: REGISTRY_HOST, task: `Downloading ${modelId} (through Ollama)`, direction: "in" as const };
  await sink.append({ ...base, ts: new Date().toISOString(), bytesSent: 0, bytesReceived: 0, ok: false, phase: "sent" });
  // Ollama reports progress per file ("pulling <digest>"); keep the largest count per file.
  const perFile = new Map<string, number>();
  const received = () => [...perFile.values()].reduce((a, b) => a + b, 0);
  const done = async (ok: boolean) => {
    try {
      await sink.append({ ...base, ts: new Date().toISOString(), bytesSent: 0, bytesReceived: received(), ok, phase: "done" });
    } catch {
      // the "sent" line already made the egress non-repudiable
    }
  };
  try {
    await engine.pull(modelId, (p) => {
      if (p.completed !== undefined) perFile.set(p.status, Math.max(perFile.get(p.status) ?? 0, p.completed));
      onProgress(p);
    });
  } catch (err) {
    await done(false);
    throw new Error(plainPullMessage(err));
  }
  await done(true);
}

export interface SetupDeps {
  /** Is any Ollama (the user's own, or one Skovern set up) on this computer? */
  installed: () => boolean;
  install: typeof installManagedOllama;
  /** Start Ollama and wait until it answers. */
  start: () => Promise<boolean>;
  /** Remember the consent: from now on Skovern starts Ollama when the brain needs it. */
  allowAutoStart: () => void;
  pull: (modelId: string, onProgress: (p: PullProgress) => void) => Promise<void>;
  sink: FetchSink;
  probeFreeBytes?: () => Promise<number>;
}

export interface SetupTick {
  phase: SetupPhase;
  percent: number;
}

const WONT_START =
  "The helper is set up, but it didn't start. Try again — if it keeps happening, restart your computer.";

/** One click, after the user's consent: set the helper up if this computer has no Ollama, start
 *  it, then download the brain. Space for everything is checked BEFORE any byte leaves. Rejects
 *  with a plain message; the caller shows it with Try again (downloads resume). */
export async function setUpAndGet(modelId: string, brainBytes: number, onTick: (t: SetupTick) => void, deps: SetupDeps): Promise<void> {
  const needHelper = !deps.installed();
  const dist = ollamaDist();
  if (needHelper && !dist) throw new DownloadError("Skovern can't set up the helper on this kind of computer yet.");
  await ensureDiskSpace(brainBytes + (needHelper && dist ? dist.sizeBytes * 2 : 0), deps.probeFreeBytes, needHelper);

  if (needHelper) {
    onTick({ phase: "helper", percent: 0 });
    await deps.install(deps.sink, (p) => onTick(p.percent >= 100 ? { phase: "unpack", percent: 100 } : { phase: "helper", percent: p.percent }));
  }
  deps.allowAutoStart();
  onTick({ phase: "start", percent: 0 });
  if (!(await deps.start())) throw new DownloadError(WONT_START);
  onTick({ phase: "brain", percent: 0 });
  await deps.pull(modelId, (p) => onTick({ phase: "brain", percent: p.percent ?? 0 }));
}
