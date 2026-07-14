import { describe, expect, it } from "vitest";
import type { LocalModelView } from "../../../shared/local.js";
import { partitionModels } from "./local-partition.js";

function model(over: Partial<LocalModelView>): LocalModelView {
  return { id: "x", label: "X", group: "suggested", downloaded: false, tier: "green", usable: true, note: "", recommended: false, ...over };
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
});
