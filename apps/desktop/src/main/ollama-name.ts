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
