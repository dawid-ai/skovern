import { defineConfig } from "@playwright/test";

// W2: the real waitlist form in Chromium, against `astro preview` of a build
// pointed at a local api (real Postgres in a container). See e2e/setup.ts.
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/setup.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "desktop-1440", use: { browserName: "chromium", viewport: { width: 1440, height: 900 } } },
    { name: "phone-375", use: { browserName: "chromium", viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
    // P2 + P3 (loop 054): the hero's idle motion and the rounded screenshot
    // frames in the other two engines (Dawid's browser may be either).
    // Firefox's session store sometimes threw on context close
    // ("_maybeDontRestoreTabs", 2 in 20 runs); with it keeping no closed
    // tabs or windows, 0 in 30.
    { name: "firefox-1440", grep: /P2|P3/, use: { browserName: "firefox", viewport: { width: 1440, height: 900 }, launchOptions: { firefoxUserPrefs: { "browser.sessionstore.resume_from_crash": false, "browser.sessionstore.max_tabs_undo": 0, "browser.sessionstore.max_windows_undo": 0 } } } },
    { name: "webkit-1440", grep: /P2|P3/, use: { browserName: "webkit", viewport: { width: 1440, height: 900 } } },
  ],
});
