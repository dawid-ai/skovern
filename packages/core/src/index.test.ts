import { describe, expect, it } from "vitest";
import { getAppInfo } from "./index.js";

describe("core", () => {
  // Rewritten (release-updates): the version now comes from the caller (the app's own),
  // not a constant in core. Same intent: the shell gets a name and a well-formed version.
  it("returns app info the shell can render, with the version it was given", () => {
    expect(getAppInfo("0.1.0")).toEqual({ name: "Skovern", version: "0.1.0" });
  });
});
