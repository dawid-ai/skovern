import { describe, expect, it } from "vitest";
import type { LocalModelView } from "../../../shared/local.js";
import { partitionModels } from "./local-partition.js";

function model(over: Partial<LocalModelView>): LocalModelView {
  return { id: "x", label: "X", group: "suggested", downloaded: false, tier: "green", usable: true, fitLabel: "", note: "", recommended: false, tokPerSec: null, ...over };
}

describe("partitionModels — actionable-now split (embedded-first)", () => {
  it("Ollama DOWN: embedded lead, Ollama-only models are demoted to advanced", () => {
    const models = [
      model({ id: "a", embedded: true }),
      model({ id: "b" }), // Ollama-only
      model({ id: "c", embedded: true }),
      model({ id: "d", embedded: false }),
    ];
    const { here, advanced } = partitionModels(models, false);
    expect(here.map((m) => m.id)).toEqual(["a", "c"]); // the runnable ones
    expect(advanced.map((m) => m.id)).toEqual(["b", "d"]); // need Ollama, which is down
  });

  it("Ollama UP: nothing is hidden — every model is actionable, all in 'here'", () => {
    const models = [model({ id: "a", embedded: true }), model({ id: "b", embedded: false })];
    const { here, advanced } = partitionModels(models, true);
    expect(here.map((m) => m.id)).toEqual(["a", "b"]);
    expect(advanced).toEqual([]);
  });

  it("empty in → empty out", () => {
    expect(partitionModels([], false).here).toEqual([]);
    expect(partitionModels([], true).advanced).toEqual([]);
  });

  it("U5: Ollama UP — a user's OWN pulled model (group 'have', not embedded) is actionable in 'here'", () => {
    const models = [
      model({ id: "gemma2:9b", group: "have", embedded: false, downloaded: true }), // his own pull
      model({ id: "qwen2.5:3b", group: "suggested", embedded: true }), // curated embedded pick
    ];
    const { here, advanced } = partitionModels(models, true);
    expect(here.map((m) => m.id)).toEqual(["gemma2:9b", "qwen2.5:3b"]); // both usable now
    expect(advanced).toEqual([]);
  });

  it("U6: Ollama DOWN — no non-embedded model is actionable in 'here'; embedded picks stay", () => {
    const models = [
      model({ id: "gemma2:9b", group: "have", embedded: false, downloaded: true }),
      model({ id: "mixtral:8x7b", group: "suggested", embedded: false }),
      model({ id: "qwen2.5:3b", group: "suggested", embedded: true }),
    ];
    const { here, advanced } = partitionModels(models, false);
    expect(here.map((m) => m.id)).toEqual(["qwen2.5:3b"]); // only the embedded pick is actionable
    expect(here.every((m) => m.embedded)).toBe(true); // NOTHING non-embedded in the main list
    expect(advanced.map((m) => m.id)).toEqual(["gemma2:9b", "mixtral:8x7b"]);
  });
});
