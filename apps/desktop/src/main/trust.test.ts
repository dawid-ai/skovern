import { describe, expect, it } from "vitest";
import { isTrustedSender } from "./trust.js";

const RENDERER = "file:///C:/app/out/renderer/index.html";
const DEV = "http://localhost:5173";

describe("isTrustedSender", () => {
  it("rejects undefined and garbage", () => {
    expect(isTrustedSender(undefined, { devServerUrl: DEV, rendererIndexUrl: RENDERER })).toBe(false);
    expect(isTrustedSender("not a url", { devServerUrl: DEV, rendererIndexUrl: RENDERER })).toBe(false);
  });

  it("trusts only the exact bundled renderer file URL", () => {
    expect(isTrustedSender(RENDERER, { devServerUrl: undefined, rendererIndexUrl: RENDERER })).toBe(true);
    expect(
      isTrustedSender("file:///C:/somewhere/else.html", { devServerUrl: undefined, rendererIndexUrl: RENDERER }),
    ).toBe(false);
  });

  it("trusts the dev server by origin equality, not prefix", () => {
    expect(isTrustedSender(`${DEV}/`, { devServerUrl: DEV, rendererIndexUrl: RENDERER })).toBe(true);
    expect(isTrustedSender(`${DEV}/some/route`, { devServerUrl: DEV, rendererIndexUrl: RENDERER })).toBe(true);
    // the startsWith bypass class: http://localhost:5173.evil.com
    expect(isTrustedSender("http://localhost:5173.evil.com/x", { devServerUrl: DEV, rendererIndexUrl: RENDERER })).toBe(
      false,
    );
    expect(isTrustedSender("http://evil.com", { devServerUrl: DEV, rendererIndexUrl: RENDERER })).toBe(false);
  });

  it("rejects http entirely when no dev server is configured (packaged app)", () => {
    expect(isTrustedSender(`${DEV}/`, { devServerUrl: undefined, rendererIndexUrl: RENDERER })).toBe(false);
  });
});
