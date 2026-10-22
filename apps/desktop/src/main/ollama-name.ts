// Validate an Ollama model name — untrusted free text from the "pull by name" box (loop 035)
// — before it reaches Ollama's /api/pull. It's a JSON value to loopback Ollama, NOT a shell or
// path sink, but bound it to the shape real Ollama names actually take (`namespace/model:tag`,
// e.g. "mixtral:8x7b", "hf.co/user/repo:Q4_K_M") so nothing weird ever gets through. Dependency-
// free so it's unit-testable on its own. Embedded (gguf) ids like "qwen2.5:3b" also pass this.

const OLLAMA_NAME = /^[a-z0-9][a-z0-9._:/-]*$/i;

export type NameResult = { ok: true; name: string } | { ok: false; reason: string };

export function validateOllamaName(raw: string): NameResult {
  const name = raw.trim();
  if (!name) return { ok: false, reason: "Type a model name first." };
  if (name.length > 128) return { ok: false, reason: "That model name is too long." };
  if (name.includes("..")) return { ok: false, reason: "That model name isn't valid." };
  if (!OLLAMA_NAME.test(name)) return { ok: false, reason: "Use only letters, numbers, and : . / - _" };
  return { ok: true, name };
}

/** Ollama's own registry — where a name with no host part downloads from. */
export const OLLAMA_REGISTRY = "registry.ollama.ai";

/** The host Ollama will download this name from, mirroring Ollama's `ParseNameBare` (v0.40.6):
 *  drop a `:tag`, then the last part is the model and the one before it the namespace; only a name
 *  with three or more parts names a host (everything before the namespace, minus any `scheme://`).
 *  So "qwen2.5:32b" and "library/qwen2.5" → the registry, "hf.co/user/repo:Q4" → "hf.co". Used for
 *  an honest receipt (loop 047, SEC-047-2). */
export function ollamaPullHost(name: string): string {
  let s = name.trim();
  if (s.lastIndexOf(":") > s.lastIndexOf("/")) s = s.slice(0, s.lastIndexOf(":"));
  const parts = s.split("/");
  if (parts.length < 3) return OLLAMA_REGISTRY;
  let host = parts.slice(0, -2).join("/");
  const scheme = host.indexOf("://");
  if (scheme >= 0) host = host.slice(scheme + 3);
  return host.length > 0 ? host.toLowerCase() : OLLAMA_REGISTRY;
}

/** Does this name download from Ollama's own registry? Catalog brains that can become the pick and
 *  trigger the set-up must (SEC-047-2). */
export function fromOllamaRegistry(name: string): boolean {
  // A scheme ("http://registry.ollama.ai/…") would make Ollama fetch the manifest over plain http.
  return !name.includes("://") && ollamaPullHost(name) === OLLAMA_REGISTRY;
}
