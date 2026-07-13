import type { CatalogModel } from "@deskhand/core";
import type { FetchSink } from "@deskhand/core";
import { receiptedFetch } from "./receipts.js";
import snapshotJson from "./catalog-snapshot.json";

// The curated model catalog. It's DATA, not code, so it's live from day one: the
// app fetches the latest list from this public repo at use-time and ships a bundled
// snapshot as the offline fallback. The fetch is egress → receipted (github). The
// fetched JSON is UNTRUSTED network input — we validate its shape and drop any
// entry that isn't well-formed, and reject non-http links, before it reaches the UI.

const LIVE_URL = "https://raw.githubusercontent.com/dawid-ai/deskhand/main/catalog/models.json";

export interface CatalogResult {
  models: CatalogModel[];
  /** Where the list came from — the UI can say "showing the offline list". */
  source: "live" | "snapshot";
  /** A plain-language notice when we fell back (never a silent break). */
  notice?: string;
}

// Only http(s) links may render — never javascript:/data:/file: from an untrusted list.
function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

// Validate ONE entry: every field the right type, params/size finite positive,
// links http(s). Returns a clean CatalogModel or null (dropped).
function validateModel(raw: unknown): CatalogModel | null {
  if (raw === null || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const id = m["id"];
  const label = m["label"];
  const quant = m["quant"];
  const creator = m["creator"];
  const license = m["license"];
  const tradeoff = m["tradeoff"];
  const params = m["params"];
  const sizeBytes = m["sizeBytes"];
  const homepage = safeHttpUrl(m["homepage"]);
  const licenseUrl = safeHttpUrl(m["licenseUrl"]);
  if (
    typeof id !== "string" || id.length === 0 || id.length > 200 ||
    typeof label !== "string" || label.length === 0 ||
    typeof quant !== "string" ||
    typeof creator !== "string" ||
    typeof license !== "string" ||
    typeof tradeoff !== "string" ||
    typeof params !== "number" || !Number.isFinite(params) || params <= 0 ||
    typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0 ||
    homepage === null ||
    licenseUrl === null
  ) {
    return null;
  }
  return { id, label, params, sizeBytes, quant, creator, homepage, license, licenseUrl, tradeoff };
}

// Validate the whole document: an object with a non-empty `models` array of valid
// entries. Malformed / empty → null so the caller falls back to the snapshot.
export function validateCatalog(doc: unknown): CatalogModel[] | null {
  if (doc === null || typeof doc !== "object") return null;
  const models = (doc as { models?: unknown }).models;
  if (!Array.isArray(models)) return null;
  const clean = models.map(validateModel).filter((m): m is CatalogModel => m !== null);
  return clean.length > 0 ? clean : null;
}

// The bundled snapshot, validated once at module load (it should always pass).
const SNAPSHOT: CatalogModel[] = validateCatalog(snapshotJson) ?? [];

/** Fetch the live catalog (receipted github egress); on any failure or malformed
 *  body, fall back to the bundled snapshot with a descriptive notice. `fetchSink`
 *  makes the fetch appear in the receipts log; `url` override is a loopback test seam. */
export async function loadCatalog(fetchSink: FetchSink, url: string = LIVE_URL): Promise<CatalogResult> {
  // The catalog list is the app's own housekeeping fetch (no business data) → routine,
  // so the panel groups it instead of a row per view-open. You pull the list in → "in".
  const doFetch = receiptedFetch(fetchSink, "Deskhand: model list", { routine: true, direction: "in" });
  try {
    const res = await doFetch(url);
    if (!res.ok) {
      return { models: SNAPSHOT, source: "snapshot", notice: `We couldn't fetch the latest model list (error ${res.status}) — showing the built-in list instead.` };
    }
    let doc: unknown;
    try {
      doc = await res.json();
    } catch {
      return { models: SNAPSHOT, source: "snapshot", notice: "The model list we got back looked wrong — showing the built-in list instead." };
    }
    const models = validateCatalog(doc);
    if (!models) {
      return { models: SNAPSHOT, source: "snapshot", notice: "The model list we got back looked wrong — showing the built-in list instead." };
    }
    return { models, source: "live" };
  } catch {
    // Offline / DNS / connection refused — the snapshot keeps the feature working.
    return { models: SNAPSHOT, source: "snapshot", notice: "We couldn't reach the model list (you may be offline) — showing the built-in list instead." };
  }
}

/** The bundled snapshot, for callers that just want a default without a fetch. */
export function snapshotCatalog(): CatalogModel[] {
  return SNAPSHOT;
}

// Opening the local view fires two IPC calls (`local:status` + `local:models`), each
// of which needs the catalog — without a cache that's two identical github fetches and
// two "model list" receipts per open. This collapses them: a load within TTL of the
// last one (or racing it) shares the SAME in-flight promise → one fetch, one receipt.
// The promise is cached, not just the result, so the near-simultaneous status+models
// pair share the in-flight request. `loadCatalog` never rejects (falls back to the
// snapshot), so a cached promise is always safe to hand back.
// ponytail: 3s TTL — long enough to collapse one view-open's two calls, short enough
// that "Check my computer again" a moment later still refetches a fresh list.
const CATALOG_TTL_MS = 3000;

export function createCachedCatalogLoader(
  now: () => number = () => Date.now(),
): (fetchSink: FetchSink, url?: string) => Promise<CatalogResult> {
  let cache: { url: string; at: number; promise: Promise<CatalogResult> } | null = null;
  return function load(fetchSink: FetchSink, url: string = LIVE_URL): Promise<CatalogResult> {
    const t = now();
    if (cache && cache.url === url && t - cache.at < CATALOG_TTL_MS) return cache.promise;
    const promise = loadCatalog(fetchSink, url);
    cache = { url, at: t, promise };
    return promise;
  };
}
