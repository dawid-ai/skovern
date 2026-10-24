import { describe, expect, it } from "vitest";
import { testPasswordStore } from "./password-store.js";

describe("SKOVERN_PASSWORD_STORE test seam", () => {
  it("selects gnome-libsecret in an unpackaged app", () => {
    expect(testPasswordStore(false, { SKOVERN_PASSWORD_STORE: "gnome-libsecret" })).toBe("gnome-libsecret");
  });

  it("never selects plaintext storage", () => {
    for (const v of ["basic", "Basic", " basic", "gnome-libsecret basic", "kwallet", ""]) {
      expect(testPasswordStore(false, { SKOVERN_PASSWORD_STORE: v })).toBeNull();
    }
  });

  it("is ignored by a packaged app", () => {
    expect(testPasswordStore(true, { SKOVERN_PASSWORD_STORE: "gnome-libsecret" })).toBeNull();
  });

  it("does nothing when unset", () => {
    expect(testPasswordStore(false, {})).toBeNull();
  });
});
