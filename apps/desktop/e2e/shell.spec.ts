import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

// contract 001 metric: window opens, title is Skovern, home screen renders,
// the preload→IPC→core chain returns real app info, app quits cleanly.
test("the shell boots", async () => {
  // Isolate the profile: this checks the first-run (signed-out) screen, so a
  // real session on the dev machine — e.g. from running the app by hand — must
  // not flip it into the signed-in view.
  const userDataDir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const app = await electron.launch({ args: [".", `--user-data-dir=${userDataDir}`] });

  try {
    const page = await app.firstWindow();

    await expect(page).toHaveTitle("Skovern");
    await expect(page.getByRole("heading", { name: /your new desk hand/i })).toBeVisible();

    // "running locally" only renders after getAppInfo() resolves through
    // preload → IPC (trusted-sender check) → @skovern/core
    await expect(page.getByText(/running locally/)).toBeVisible();
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
