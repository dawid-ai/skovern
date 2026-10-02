import { describe, expect, it } from "vitest";
import { brainSwitchPlan } from "./brain-switch.js";

// Loop 045 B1: switching brains frees the outgoing one, in every direction.
const embedded = (id: string): boolean => id === "qwen2.5:3b" || id === "qwen2.5:14b";

describe("brainSwitchPlan", () => {
  it("U1: outgoing embedded, incoming Ollama → unload the embedded model", () => {
    const plan = brainSwitchPlan({ provider: "local", model: "qwen2.5:14b" }, { provider: "local", model: "mistral:7b" }, embedded);
    expect(plan).toEqual({ unloadEmbedded: true, unloadOllama: [] });
  });

  it("U2: outgoing Ollama, incoming embedded → unload the Ollama model", () => {
    const plan = brainSwitchPlan({ provider: "local", model: "mistral:7b" }, { provider: "local", model: "qwen2.5:3b" }, embedded);
    expect(plan).toEqual({ unloadEmbedded: false, unloadOllama: ["mistral:7b"] });
  });

  it("U3: outgoing local, incoming cloud → the local model is still freed", () => {
    expect(brainSwitchPlan({ provider: "local", model: "qwen2.5:3b" }, { provider: "anthropic" }, embedded)).toEqual({
      unloadEmbedded: true,
      unloadOllama: [],
    });
    expect(brainSwitchPlan({ provider: "local", model: "mistral:7b" }, { provider: "claude-cli" }, embedded)).toEqual({
      unloadEmbedded: false,
      unloadOllama: ["mistral:7b"],
    });
  });

  it("U4: re-saving the same model frees nothing", () => {
    expect(brainSwitchPlan({ provider: "local", model: "qwen2.5:3b" }, { provider: "local", model: "qwen2.5:3b" }, embedded)).toEqual({
      unloadEmbedded: false,
      unloadOllama: [],
    });
    expect(brainSwitchPlan({ provider: "local", model: "mistral:7b" }, { provider: "local", model: "mistral:7b" }, embedded)).toEqual({
      unloadEmbedded: false,
      unloadOllama: [],
    });
  });

  it("U5: no previous brain → nothing to unload, no throw", () => {
    expect(brainSwitchPlan(null, { provider: "local", model: "qwen2.5:3b" }, embedded)).toEqual({ unloadEmbedded: false, unloadOllama: [] });
    expect(brainSwitchPlan({ provider: "openrouter" }, { provider: "local", model: "qwen2.5:3b" }, embedded)).toEqual({
      unloadEmbedded: false,
      unloadOllama: [],
    });
  });

  it("U6: outgoing brain connected by address → never reach off-box to unload it", () => {
    const prev = { provider: "local", model: "llama3:70b", endpoint: "http://192.168.1.5:11434" };
    expect(brainSwitchPlan(prev, { provider: "local", model: "qwen2.5:3b" }, embedded)).toEqual({ unloadEmbedded: false, unloadOllama: [] });
    expect(brainSwitchPlan(prev, { provider: "anthropic" }, embedded).unloadOllama).toEqual([]);
  });

  it("switching from a loopback model to the same model on a connected box frees the loopback one", () => {
    const plan = brainSwitchPlan(
      { provider: "local", model: "mistral:7b" },
      { provider: "local", model: "mistral:7b", endpoint: "http://192.168.1.5:11434" },
      embedded,
    );
    expect(plan).toEqual({ unloadEmbedded: false, unloadOllama: ["mistral:7b"] });
  });
});
