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

  it("never returns a blank card for an unrecognized permission (JS caller safety)", () => {
    // a JS caller can pass anything; the card must warn, not go blank
    const text = explainCapability("totally-unknown" as Capability);
    expect(text.length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toMatch(/not.*allow|don't allow|recognize/);
  });
});
