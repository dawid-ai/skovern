import { describe, expect, it } from "vitest";
import { appInfo } from "./app-info.js";

describe("app:info", () => {
  // release-updates M1: every screen's version comes from app.getVersion().
  it("returns the running app's version", () => {
    expect(appInfo({ getVersion: () => "0.4.2" })).toEqual({ name: "Skovern", version: "0.4.2" });
  });
});
