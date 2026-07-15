import { describe, expect, it } from "vitest";
import { pickSelfReliantFallback, type BrainRef } from "./brain-fallback.js";

const ollama: BrainRef = { provider: "local", model: "mistral-small:latest" };

describe("pickSelfReliantFallback", () => {
  it("falls back to the downloaded built-in when the Ollama brain is unreachable", () => {
    expect(pickSelfReliantFallback(ollama, false, false, "qwen2.5:3b")).toBe("qwen2.5:3b");
  });

  it("does NOT fall back while Ollama is reachable", () => {
    expect(pickSelfReliantFallback(ollama, false, true, "qwen2.5:3b")).toBeNull();
  });

  it("does not fall back if no built-in model is downloaded (normal path fails honestly)", () => {
    expect(pickSelfReliantFallback(ollama, false, false, null)).toBeNull();
  });

  it("leaves an already-embedded local brain alone", () => {
    const embedded: BrainRef = { provider: "local", model: "qwen2.5:3b" };
    expect(pickSelfReliantFallback(embedded, true, false, "qwen2.5:7b")).toBeNull();
  });

  it("leaves cloud / CLI brains alone", () => {
    expect(pickSelfReliantFallback({ provider: "openrouter", model: "x" }, false, false, "qwen2.5:3b")).toBeNull();
    expect(pickSelfReliantFallback({ provider: "claude-cli", model: null }, false, false, "qwen2.5:3b")).toBeNull();
  });

  it("leaves an absent brain alone", () => {
    expect(pickSelfReliantFallback(null, false, false, "qwen2.5:3b")).toBeNull();
  });
});
