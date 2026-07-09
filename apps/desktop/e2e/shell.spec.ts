import { _electron as electron, expect, test } from "@playwright/test";

// contract 001 metric: window opens, title is Deskhand, home screen renders,
// the preload→IPC→core chain returns real app info, app quits cleanly.
test("the shell boots", async () => {
  const app = await electron.launch({ args: ["."] });
  const page = await app.firstWindow();

  await expect(page).toHaveTitle("Deskhand");
  await expect(page.getByRole("heading", { name: /your new desk hand/i })).toBeVisible();

  // "running locally" only renders after getAppInfo() resolves through
  // preload → IPC (trusted-sender check) → @deskhand/core
  await expect(page.getByText(/running locally/)).toBeVisible();

  await app.close();
});
