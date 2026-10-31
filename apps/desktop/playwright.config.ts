import { defineConfig } from "@playwright/test";

// Loop 047: whether Skovern can set Ollama up depends on the platform (a pinned helper build exists
// for Windows x64 only), and it changes the pick. Turn it off for every spec so PASS/FAIL is the
// same on a Windows dev box and Linux CI; `managed-ollama.spec.ts` turns it on with a fixture.
process.env["SKOVERN_OLLAMA_DIST"] = "off";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
