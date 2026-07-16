import { describe, expect, it } from "vitest";
import { validateOllamaName } from "./ollama-name.js";

// Loop 035 Issue 3 — the "pull by name" box is untrusted free text hitting Ollama's /api/pull.
// Validate it to a real Ollama-name shape with a SPECIFIC reason, before any pull.

describe("validateOllamaName", () => {
  it("U3: accepts well-formed Ollama names (incl. namespace/tag) + embedded ids", () => {
    for (const n of ["mixtral:8x7b", "gemma2:27b", "qwen2.5:32b", "hf.co/user/repo:Q4_K_M", "llama3.1", "qwen2.5:3b"]) {
      expect(validateOllamaName(n)).toEqual({ ok: true, name: n });
    }
    expect(validateOllamaName("  gemma2:27b  ")).toEqual({ ok: true, name: "gemma2:27b" }); // trimmed
  });

  it("U4: rejects malformed names with a specific reason, never passes them through", () => {
    expect(validateOllamaName("")).toEqual({ ok: false, reason: "Type a model name first." });
    expect(validateOllamaName("   ")).toEqual({ ok: false, reason: "Type a model name first." });
    // spaces / shell + control chars
    expect(validateOllamaName("mixtral 8x7b").ok).toBe(false);
    expect(validateOllamaName("gemma2;rm -rf").ok).toBe(false);
    expect(validateOllamaName("model$(whoami)").ok).toBe(false);
    expect(validateOllamaName("a\nb").ok).toBe(false);
    // traversal-ish
    expect(validateOllamaName("../etc/passwd")).toEqual({ ok: false, reason: "That model name isn't valid." });
    // over-long
    expect(validateOllamaName("a".repeat(129))).toEqual({ ok: false, reason: "That model name is too long." });
  });
});
