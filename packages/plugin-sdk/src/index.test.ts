import { describe, expect, it } from "vitest";
import { CAPABILITIES, explainCapability, type Capability } from "./index.js";

describe("plugin sdk", () => {
  it("explains every capability in plain, florist-friendly language", () => {
    for (const c of CAPABILITIES) {
      const text = explainCapability(c);
      expect(text.length).toBeGreaterThan(0);
      // no developer jargon leaks into the permission card
      expect(text.toLowerCase()).not.toMatch(/api|http|token|mcp|plugin runtime/);
    }
    expect(explainCapability("fetch")).toMatch(/receipt/i);
  });

  it("CAPABILITIES lists exactly the known capabilities", () => {
    const expected: Capability[] = ["brain", "fetch"];
    expect([...CAPABILITIES].sort()).toEqual(expected.sort());
  });
});
