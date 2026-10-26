import { expect, test, type Page } from "@playwright/test";

// W2: the waitlist form end to end, at 1440 and at 375 (two projects).

const www = (): string => process.env["WWW_URL"] ?? "";
const api = (): string => process.env["API_URL"] ?? "";
// The api limits signups per client address (8 per 10 minutes). This file
// makes 3 real signups per project, 6 in all, from one fresh api process.

async function noOverflow(page: Page): Promise<void> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, "horizontal overflow in px").toBeLessThanOrEqual(0);
}

async function adminCsv(): Promise<string> {
  const auth = `Basic ${Buffer.from(`e2e:${process.env["ADMIN_TOKEN"]}`).toString("base64")}`;
  return (await fetch(`${api()}/admin/waitlist.csv`, { headers: { authorization: auth } })).text();
}

async function step1(page: Page, name: string, email: string): Promise<number> {
  await page.goto(`${www()}/#waitlist`);
  const form = page.locator("#waitlist .wl-s1");
  await form.getByLabel("Your name").fill(name);
  await form.getByLabel("Email").fill(email);
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  const ok = page.locator("#waitlist .wl-okh");
  await expect(ok).toContainText(`You're on the list, ${name.split(" ")[0]}. You're #`);
  const n = Number((await ok.textContent())?.match(/#(\d+)/)?.[1]);
  expect(n).toBeGreaterThan(0);
  await expect(page.locator("#waitlist .wl-s2wrap .wl-num")).toHaveText(`#${n}`);
  return n;
}

test("step 1 shows the number, and Send saves step 2", async ({ page }, info) => {
  const email = `send-${info.project.name}@bloom.test`;
  const n = await step1(page, "Rosa Diaz", email);
  await noOverflow(page);
  const s2 = page.locator("#waitlist .wl-s2");
  await s2.getByLabel("Your job title").fill("Owner");
  await s2.getByLabel("Business type").selectOption("florist");
  await s2.getByLabel("Your website").fill("bloomandvine.shop");
  await s2.getByRole("button", { name: "Send" }).click();
  await expect(page.locator("#waitlist .wl-doneh")).toHaveText("Thanks, Rosa. That helps a lot.");
  await expect(page.locator("#waitlist .wl-donep")).toContainText(`You're still #${n}.`);
  await noOverflow(page);
  const csv = await adminCsv();
  expect(csv).toContain(`"${n}","Rosa Diaz","${email}","Owner","florist","https://bloomandvine.shop"`);
});

test("Skip reaches the done state without step 2", async ({ page }, info) => {
  const n = await step1(page, "Lee", `skip-${info.project.name}@bakery.test`);
  await page.locator("#waitlist .wl-s2").getByRole("button", { name: "Skip" }).click();
  await expect(page.locator("#waitlist .wl-doneh")).toHaveText("All set, Lee.");
  await expect(page.locator("#waitlist .wl-donep")).toHaveText(`You're #${n} on the list. No extra questions.`);
});

test("errors show under the field they belong to", async ({ page }) => {
  await page.goto(`${www()}/#waitlist`);
  const form = page.locator("#waitlist .wl-s1");
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(form.locator("#wl-main-name-e")).toHaveText("Tell us what to call you.");
  await expect(form.getByLabel("Your name")).toHaveAttribute("aria-invalid", "true");
  await expect(form.locator("#wl-main-email-e")).toHaveText("We need an email to save your spot.");
  await form.getByLabel("Your name").fill("Rosa");
  await form.getByLabel("Email").fill("rosa@bloom");
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(form.locator("#wl-main-name-e")).toBeEmpty();
  await expect(form.locator("#wl-main-email-e")).toHaveText("That email looks off. Check for a typo?");
  await noOverflow(page);

  await form.getByLabel("Email").fill(`errors-${Date.now()}@bloom.test`);
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  const s2 = page.locator("#waitlist .wl-s2");
  await s2.getByLabel("Your website").fill("javascript:alert(1)");
  await s2.getByRole("button", { name: "Send" }).click();
  await expect(s2.locator("#wl-main-url-e")).toHaveText("That doesn't look like a web address. Try something like bloomandvine.shop.");
  await s2.getByLabel("Your website").fill("");
  await s2.getByRole("button", { name: "Send" }).click();
  await expect(s2.locator("#wl-main-type-e")).toHaveText("Fill in at least one, or tap Skip.");
});

test("with the api down, it says so and never fakes a success", async ({ page }) => {
  await page.route(`${api()}/**`, (route) => route.abort("connectionrefused"));
  await page.goto(`${www()}/#waitlist`);
  const form = page.locator("#waitlist .wl-s1");
  await form.getByLabel("Your name").fill("Rosa");
  await form.getByLabel("Email").fill("down@bloom.test");
  await form.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(form.getByRole("alert")).toHaveText("Couldn't reach us, try again.");
  await expect(page.locator("#waitlist .wl-s2wrap")).toBeHidden();
  await expect(page.locator("#waitlist .wl-num").first()).toBeEmpty();
  await expect(form.getByRole("button", { name: "Join the waitlist" })).toBeEnabled();
  await noOverflow(page);
});

test("no page scrolls sideways", async ({ page }) => {
  for (const path of ["/", "/blog/", "/blog/ai-for-your-flower-shop-without-sharing-customer-info/", "/privacy/", "/waitlist/done/?n=12", "/waitlist/oops/?error=email", "/waitlist/remove/", "/nope"]) {
    await page.goto(`${www()}${path}`);
    await noOverflow(page);
  }
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  // Each test posts from its own address, so the per-IP limit is measured per test.
  const ip = (project: string, n: number): string => `203.0.113.${(project === "phone-375" ? 100 : 0) + n}`;

  async function submit(page: Page, name: string, email: string): Promise<void> {
    await page.goto(`${www()}/#waitlist`);
    const form = page.locator("#waitlist .wl-s1");
    await form.getByLabel("Your name").fill(name);
    await form.getByLabel("Email").fill(email);
    await form.getByRole("button", { name: "Join the waitlist" }).click();
  }

  test("a signup lands on the done page", async ({ page }, info) => {
    await page.setExtraHTTPHeaders({ "x-forwarded-for": ip(info.project.name, 1) });
    await submit(page, "Rosa", `nojs-${info.project.name}@bloom.test`);
    await expect(page).toHaveURL(/\/waitlist\/done\/\?n=\d+$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("You're on the list.");
    await expect(page.getByText("We emailed you your number.")).toBeVisible();
    await noOverflow(page);
  });

  test("a refused signup says it didn't go through", async ({ page }, info) => {
    await page.setExtraHTTPHeaders({ "x-forwarded-for": ip(info.project.name, 2) });
    await submit(page, "Rosa", "rosa@bloom");
    await expect(page).toHaveURL(/\/waitlist\/oops\/\?error=email$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("That didn't go through.");
    await expect(page.getByText("Check your email address and try again.")).toBeVisible();
    await expect(page.getByText("You're on the list")).toHaveCount(0);
  });

  test("too many tries says it didn't go through", async ({ page }, info) => {
    const addr = ip(info.project.name, 3);
    for (let i = 0; i < 8; i += 1) {
      await fetch(`${api()}/api/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": addr },
        body: "{}",
      });
    }
    await page.setExtraHTTPHeaders({ "x-forwarded-for": addr });
    await submit(page, "Rosa", `busy-${info.project.name}@bloom.test`);
    await expect(page).toHaveURL(/\/waitlist\/oops\/\?error=busy$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("That didn't go through.");
    await expect(page.getByText("You're on the list")).toHaveCount(0);
  });
});
