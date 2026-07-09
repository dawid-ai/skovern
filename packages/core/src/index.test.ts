import { describe, expect, it } from "vitest";
import { CORE_VERSION, getAppInfo } from "./index.js";

describe("core", () => {
  it("exports a semver version", () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("returns app info the shell can render", () => {
    expect(getAppInfo()).toEqual({ name: "Deskhand", version: CORE_VERSION });
  });
});
