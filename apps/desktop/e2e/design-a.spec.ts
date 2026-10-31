import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { AuthService, AuthStore, ConsoleMailer, ConsoleNotifier, DmStore, startAuthServer, type RunningServer } from "@skovern/site";

// Loop 049 (design A "Clear") app-level metric: the REAL Electron UI against the real server.
//   D1 every page × light/dark × 1100×720 and 800×520: no sideways overflow, nav + page title
//      visible, body background luminance per theme, WCAG AA contrast for body text and the
//      selected nav item (computed in-page from computed styles).
//   D2 degraded states: brain missing/asleep → the chip says so and isn't green; no chats →
//      empty state + a usable New chat; update waiting → the notice fits 800×520, clear of Send.
//   D3 Chat at 800×520: last message above the composer, composer visible, chat list reachable.
//   D4 reduced motion: no running animation or transition longer than 0.01 s on the shell.
//   D5 no request leaves file:// or loopback during a full page tour.
// Fixtures follow production: routine update-check + messages-poll receipts, a 24 GB computer
// with no Ollama (SKOVERN_HARDWARE), the fake updater, a test database, and the fake brain.

const HARDWARE = JSON.stringify({
  ramBytes: 24 * 1024 ** 3,
  cpuCores: 8,
  gpus: [],
  bestVramBytes: 0,
  unifiedMemory: false,
  diskFreeBytes: 400 * 1024 ** 3,
  notes: [],
});
const ADMIN_PW = "design-a-loop-test-pw";
// Long strings that would push a layout sideways if anything forgot to wrap or truncate (N8).
const LONG_TITLE = "Wedding quote for the Parkers: twelve centerpieces, a bridal bouquet, and the ceremony arch";
const LONG_URL = "https://www.bloomandvine-wholesale-flower-supplier-catalogue.example.co.uk/catalogue/autumn-2026/dried-hydrangea-bundles-xl";
const LONG_HOST = "www.bloomandvine-wholesale-flower-supplier-catalogue.example.co.uk";
const LONG_FILE = "qwen2.5-14b-instruct-q4_k_m-00001-of-00002-extra-long-shard-name-for-layout.gguf";
const FOUNDER_REPLY = "Thanks for trying Skovern. Anything confusing so far?";
const PAGES = ["What's new", "Chat", "Your brain", "Messages", "Skills", "Receipts", "Settings"] as const;
const SIZES = [
  [1100, 720],
  [800, 520],
] as const;

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let server: RunningServer;
let mailer: ConsoleMailer;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await new AuthStore(pool).migrate();
  mailer = new ConsoleMailer();
  const auth = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
  const dm = new DmStore(pool);
  await dm.migrate();
  server = await startAuthServer({ service: auth, dm: { auth, store: dm, notifier: new ConsoleNotifier() }, adminToken: ADMIN_PW });
});

test.afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
});

// Production-shaped receipts: the routine polls Skovern makes on its own, plus a few real rows.
function seedReceipts(dir: string): void {
  const day = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const fetchRow = (task: string, host: string, direction: "in" | "out", routine: boolean, sent: number, got: number) => [
    { kind: "fetch", host, task, direction, ...(routine ? { routine } : {}), ts: day, bytesSent: sent, bytesReceived: 0, ok: true, phase: "sent" },
    { kind: "fetch", host, task, direction, ...(routine ? { routine } : {}), ts: day, bytesSent: sent, bytesReceived: got, ok: true, phase: "done" },
  ];
  const rows = [
    ...fetchRow("Skovern: update check", "github.com", "in", true, 0, 0),
    ...fetchRow("Skovern: messages", "127.0.0.1", "in", true, 0, 300),
    ...fetchRow("Skovern: your message to Dawid", "127.0.0.1", "out", false, 1200, 300),
    ...fetchRow(`Downloading ${LONG_FILE}`, "huggingface.co", "in", false, 400, 8_988_110_976),
    ...fetchRow(`skill:ai-visibility fetch ${LONG_URL}`, LONG_HOST, "in", false, 600, 48_200),
    { provider: "local", model: "qwen2.5:3b", task: "Chat", bytesSent: 0, bytesReceived: 0, ok: true, phase: "done", local: true, tokensIn: 40, tokensOut: 90, ts: day },
  ];
  writeFileSync(path.join(dir, "receipts.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function seedChat(dir: string, turns: number, title = "Autumn wreath captions"): void {
  const chats = path.join(dir, "chats");
  mkdirSync(chats, { recursive: true });
  const ts = "2026-10-20T10:00:00.000Z";
  writeFileSync(path.join(chats, "index.json"), JSON.stringify([{ id: "long", title, createdAt: ts, updatedAt: ts }]));
  const lines: string[] = [];
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ role: "user", content: `question ${i}: can you check ${LONG_URL} for the wreaths?`, ts }));
    lines.push(JSON.stringify({ role: "assistant", content: `answer ${i}: sure, here is a short caption for the window.`, ts }));
  }
  writeFileSync(path.join(chats, "long.jsonl"), lines.join("\n") + "\n");
}

async function launch(dir: string, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SKOVERN_API_URL: server.url,
    SKOVERN_HARDWARE: HARDWARE,
    SKOVERN_OLLAMA_URL: "http://127.0.0.1:1",
    SKOVERN_OLLAMA_INSTALLED: "0",
    SKOVERN_LLAMA_FAKE: "1",
    ...extra,
  };
  if (!("SKOVERN_UPDATER_FAKE" in extra)) delete env["SKOVERN_UPDATER_FAKE"];
  const app = await electron.launch({ args: [".", `--user-data-dir=${dir}`], env });
  return { app, page: await app.firstWindow() };
}

let accounts = 0;
async function signIn(page: Page): Promise<void> {
  accounts += 1;
  const before = mailer.sent.length;
  await page.getByLabel("Your email").fill(`design${accounts}@shop.test`);
  await page.getByRole("button", { name: "Send me a link" }).click();
  await expect.poll(() => mailer.sent.length, { timeout: 30_000 }).toBeGreaterThan(before);
  await page.getByLabel("Paste your link").fill(mailer.sent[mailer.sent.length - 1]!.url);
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText(/founding user #/i)).toBeVisible();
}

// A configured local brain, written the way the app writes it (OS-encrypted), then a reload so the
// shell reads it now instead of on its next poll.
async function seedLocalBrain(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ app: a, safeStorage }) => {
    const fs = process.getBuiltinModule("node:fs");
    const p = process.getBuiltinModule("node:path");
    const config = JSON.stringify({ provider: "local", key: "", model: "qwen2.5:3b" });
    fs.writeFileSync(p.join(a.getPath("userData"), "brain.bin"), safeStorage.encryptString(config));
  });
  await page.reload();
  await expect(page.getByText(/founding user #/i)).toBeVisible();
}

async function resize(app: ElectronApplication, page: Page, w: number, h: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0]!.setContentSize(cw!, ch!), [w, h]);
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([w, h]);
}

const nav = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });

// A speaker label under a bubble ("Your brain", "Dawid") must really be on screen: a real height,
// not clipped away, not transparent. Playwright's toBeVisible() counts a 1x1 clipped box as visible.
async function labelShown(page: Page, selector: string): Promise<{ height: number; clipped: boolean; opacity: number; text: string }> {
  return page.locator(selector).last().evaluate((el) => {
    let opacity = 1;
    let clipped = false;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      opacity *= Number(cs.opacity);
      if ((cs.clipPath !== "none" && cs.clipPath !== "") || (cs.clip !== "auto" && cs.clip !== "")) clipped = true;
    }
    return { height: el.getBoundingClientRect().height, clipped, opacity, text: el.textContent ?? "" };
  });
}

// In-page measurements from computed styles: overflow, body luminance, and contrast ratios with
// translucent colors composited over the element's real (ancestor) background.
async function measure(page: Page): Promise<{ overflow: number; bodyLum: number; text: number; secondary: number; weakest: string; title: number; navSel: number }> {
  return page.evaluate(() => {
    type C = [number, number, number, number];
    const parse = (s: string): C => {
      const n = (s.match(/[\d.]+/g) ?? []).map(Number);
      const srgb = s.startsWith("color(");
      const k = srgb ? 255 : 1;
      return [n[0]! * k, n[1]! * k, n[2]! * k, n[3] ?? 1];
    };
    const over = (top: C, under: C): C => {
      const a = top[3];
      return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
    };
    const bgOf = (el: Element): C => {
      const stack: C[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) stack.push(c);
        if (c[3] >= 1) break;
      }
      return stack.reverse().reduce<C>((acc, c) => over(c, acc), [255, 255, 255, 1]);
    };
    const lum = (c: C): number => {
      const f = (v: number): number => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const contrast = (el: Element | null): number => {
      if (!el) return 0;
      const bg = bgOf(el);
      const fg = over(parse(getComputedStyle(el).color), bg);
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
      return (a + 0.05) / (b + 0.05);
    };
    const main = document.querySelector("main.content");
    const overflow = Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      main ? main.scrollWidth - main.clientWidth : 0,
    );
    return {
      overflow,
      bodyLum: lum(parse(getComputedStyle(document.body).backgroundColor)),
      text: contrast(document.querySelector("main .page-head p, main .stamp")),
      // The weakest secondary text actually on screen: hints, footers, sub-lines, times, labels.
      ...(() => {
        const sel = "main .hint, main .g-foot, main .g-intro, main .receipt-where, main .receipt-why, main .chat-when, main .bubble .who, main .cal-head p, .og-badge, .brain-chip-state";
        let secondary = 99;
        let weakest = "";
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = el.getBoundingClientRect();
          if (r.height < 6 || r.bottom < 0 || r.top > window.innerHeight || !(el.textContent ?? "").trim()) continue;
          if (el.closest(".from-you") && el.classList.contains("who")) continue; // "You" is screen-reader only
          const c = contrast(el);
          if (c < secondary) {
            secondary = c;
            weakest = `${el.className}: ${(el.textContent ?? "").trim().slice(0, 40)}`;
          }
        }
        return { secondary, weakest };
      })(),
      title: contrast(document.querySelector("main h1")),
      navSel: contrast(document.querySelector(".nav-item.active .nav-label")),
    };
  });
}

test("D1 + D4 + D5: every page, both themes, both sizes; reduced motion; nothing leaves loopback", async () => {
  test.setTimeout(240_000);
  const dir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  seedReceipts(dir);
  seedChat(dir, 6, LONG_TITLE);
  const { app, page } = await launch(dir, { SKOVERN_BRAIN_LOADED: "1" });
  const offBox: string[] = [];
  page.on("request", (r) => {
    const u = r.url();
    if (!/^(file:|data:|devtools:|blob:|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(u)) offBox.push(u);
  });
  try {
    await signIn(page);
    await seedLocalBrain(app, page);

    // Dawid replies, so Messages has a founder bubble with its label.
    const email = `design${accounts}@shop.test`;
    const { rows: acct } = await pool.query<{ id: string }>("SELECT id FROM accounts WHERE email = $1", [email]);
    const res = await fetch(`${server.url}/admin/dm/reply`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Basic " + Buffer.from(`admin:${ADMIN_PW}`).toString("base64") },
      body: new URLSearchParams({ accountId: acct[0]!.id, body: FOUNDER_REPLY }).toString(),
      redirect: "manual",
    });
    expect([302, 303]).toContain(res.status);
    await expect(page.getByLabel(/unread/)).toBeVisible({ timeout: 20_000 });
    await nav(page, "Messages").click();
    await expect(page.getByText(FOUNDER_REPLY)).toBeVisible();

    // N6: a chat row's accessible name is exactly its title; the time beside it is decoration.
    await nav(page, "Chat").click();
    await expect(page.locator(".chat-list").getByRole("button", { name: LONG_TITLE, exact: true })).toBeVisible();

    // N2: the receipts list is still a table to a screen reader, with all six column headers.
    await nav(page, "Receipts").click();
    const table = page.getByRole("table");
    await expect(table.getByRole("columnheader")).toHaveCount(6);
    const dataRows = await page.locator(".receipt-list tbody tr").count();
    expect(dataRows).toBeGreaterThan(0);
    await expect(table.getByRole("row")).toHaveCount(dataRows + 1);
    await expect(table.getByRole("cell")).toHaveCount(dataRows * 6);

    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [w, h] of SIZES) {
        await resize(app, page, w, h);
        for (const name of PAGES) {
          const where = `${name} ${scheme} ${w}×${h}`;
          await nav(page, name).click();
          await expect(page.locator("main h1").first(), where).toBeVisible();
          await expect(page.locator("main h1").first(), where).toBeInViewport();
          await expect(nav(page, name), where).toBeInViewport();
          // The sidebar is a full list at 1100 wide and an icon rail at 800 wide.
          const navWidth = (await page.locator("nav.sidebar").boundingBox())!.width;
          if (w === 800) expect(navWidth, where).toBeLessThanOrEqual(80);
          else expect(navWidth, where).toBeGreaterThanOrEqual(200);
          await page.waitForTimeout(150); // let the entrance settle before reading colors
          const m = await measure(page);
          expect(m.overflow, `${where}: sideways overflow`).toBeLessThanOrEqual(0);
          if (scheme === "light") expect(m.bodyLum, where).toBeGreaterThan(0.85);
          else expect(m.bodyLum, where).toBeLessThan(0.1);
          expect(m.text, `${where}: body text contrast`).toBeGreaterThanOrEqual(4.5);
          expect(m.secondary, `${where}: weakest secondary text (${m.weakest})`).toBeGreaterThanOrEqual(4.5);
          expect(m.title, `${where}: title contrast`).toBeGreaterThanOrEqual(4.5);
          expect(m.navSel, `${where}: selected nav contrast`).toBeGreaterThanOrEqual(4.5);
          // The speaker labels are real, visible text (the copy freeze): "Your brain" and "Dawid".
          const label = name === "Chat" ? ".chat-thread .from-brain .who" : name === "Messages" ? ".from-founder .who" : null;
          if (label) {
            const l = await labelShown(page, label);
            expect(l.text, where).toBe(name === "Chat" ? "Your brain" : "Dawid");
            expect(l.height, `${where}: label height`).toBeGreaterThanOrEqual(6);
            expect(l.clipped, `${where}: label clipped`).toBe(false);
            expect(l.opacity, `${where}: label opacity`).toBeGreaterThan(0.9);
          }
        }
      }
    }

    // D4: with reduced motion, nothing on the shell animates or transitions longer than 0.01 s.
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    for (const name of PAGES) {
      await nav(page, name).click();
      await expect(page.locator("main h1").first()).toBeVisible();
      const moving = await page.evaluate(() => {
        const secs = (v: string): number => Math.max(0, ...v.split(",").map((t) => (t.trim().endsWith("ms") ? parseFloat(t) / 1000 : parseFloat(t))));
        const slow: string[] = [];
        for (const a of document.getAnimations()) {
          const d = Number(a.effect?.getComputedTiming().duration ?? 0);
          if (a.playState === "running" && d > 10) slow.push(`animation ${d}ms`);
        }
        for (const el of document.querySelectorAll(".shell, .shell *")) {
          const cs = getComputedStyle(el);
          const t = secs(cs.transitionDuration);
          const an = cs.animationName !== "none" ? secs(cs.animationDuration) : 0;
          if (t > 0.01 || an > 0.01) slow.push(`${el.className}: transition ${t}s animation ${an}s`);
        }
        return slow;
      });
      expect(moving, name).toEqual([]);
    }

    // D5: the whole tour stayed on this computer.
    expect(offBox).toEqual([]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D2: a missing or asleep brain says so and isn't green; no chats still gives a usable New chat", async () => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  const { app, page } = await launch(dir, { SKOVERN_BRAIN_LOADED: "0" });
  const green = async (): Promise<boolean> =>
    page.locator(".brain-chip .brain-dot").evaluate((d) => {
      const [r, g, b] = (getComputedStyle(d).backgroundColor.match(/[\d.]+/g) ?? []).map(Number) as [number, number, number];
      return g > 150 && g > r * 1.3 && g > b * 1.3;
    });
  try {
    await signIn(page);
    // No brain at all.
    await expect(page.locator(".brain-chip")).toContainText("No brain yet");
    expect(await green()).toBe(false);

    // No chats: Chat opens on its empty state, and New chat makes another usable chat.
    await nav(page, "Chat").click();
    await expect(page.getByText("Say something to get started.")).toBeVisible();
    const rows = page.locator(".chat-list .chat-row");
    const before = await rows.count();
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(rows).toHaveCount(before + 1);
    await expect(page.getByLabel("Message your brain")).toBeVisible();

    // A configured private brain that's asleep: the chip says "Asleep" and stays gray.
    await seedLocalBrain(app, page);
    await expect(page.locator(".brain-chip")).toContainText("Local: qwen2.5:3b");
    await expect(page.locator(".brain-chip")).toContainText("Asleep");
    await expect(page.locator(".brain-chip")).toHaveClass(/brain-chip-asleep/);
    expect(await green()).toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D2 + D3: at 800×520 the update notice fits and clears Send; Chat keeps its last message and list in reach", async () => {
  test.setTimeout(120_000);
  const dir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  seedReceipts(dir);
  seedChat(dir, 30);
  const { app, page } = await launch(dir, { SKOVERN_UPDATER_FAKE: "available", SKOVERN_BRAIN_LOADED: "1" });
  try {
    await signIn(page);
    await seedLocalBrain(app, page);
    await nav(page, "Chat").click();
    await resize(app, page, 800, 520);
    await page.locator(".chat-list").getByRole("button", { name: "Autumn wreath captions" }).click();

    // D2: the update notice sits fully inside the window and doesn't cover Send.
    const notice = page.locator('aside[aria-label="Skovern update"]');
    await expect(notice.getByText("A new Skovern is here (0.99.0).")).toBeVisible();
    const box = (await notice.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(800);
    expect(box.y + box.height).toBeLessThanOrEqual(520);
    const send = (await page.getByRole("button", { name: "Send", exact: true }).boundingBox())!;
    const overlaps = box.x < send.x + send.width && send.x < box.x + box.width && box.y < send.y + send.height && send.y < box.y + box.height;
    expect(overlaps).toBe(false);

    // D3: the newest message is in view, above the composer; the composer and chat list are reachable.
    const last = page.locator(".chat-thread .bubble").last();
    await expect(last).toContainText("answer 29");
    await expect(last).toBeInViewport();
    const composer = page.locator(".chat-composer");
    await expect(composer).toBeInViewport();
    const lastBox = (await last.boundingBox())!;
    const compBox = (await composer.boundingBox())!;
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(compBox.y + 1);
    await expect(page.getByLabel("Message your brain")).toBeInViewport();
    await expect(page.locator(".chat-list").getByRole("button", { name: "Autumn wreath captions" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "New chat" })).toBeInViewport();
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// P4 (loop 054): every dropdown follows the theme, shut AND open. Electron on Windows draws a
// plain <select>'s list as a separate OS popup that Playwright can't see, and it came out light
// grey in dark mode. The selects are customizable (appearance: base-select), so the list is drawn
// in the page: these checks read its computed styles and then the real window pixels
// (webContents.capturePage) while it's open. SKOVERN_SHOTS=<dir> also saves those captures.
interface SelectReport {
  id: string;
  scheme: string;
  appearance: string;
  field: number;
  options: { label: string; scheme: string; bgAlpha: number; contrast: number; opacity: number; disabled: boolean }[];
}
async function selects(page: Page): Promise<SelectReport[]> {
  return page.evaluate(() => {
    type C = [number, number, number, number];
    const parse = (s: string): C => {
      const n = (s.match(/[\d.]+/g) ?? []).map(Number);
      const k = s.startsWith("color(") ? 255 : 1;
      return [n[0]! * k, n[1]! * k, n[2]! * k, n[3] ?? 1];
    };
    const over = (t: C, u: C): C => [t[0] * t[3] + u[0] * (1 - t[3]), t[1] * t[3] + u[1] * (1 - t[3]), t[2] * t[3] + u[2] * (1 - t[3]), 1];
    const bgOf = (el: Element): C => {
      const stack: C[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) stack.push(c);
        if (c[3] >= 1) break;
      }
      return stack.reverse().reduce<C>((acc, c) => over(c, acc), [255, 255, 255, 1]);
    };
    const lum = (c: C): number =>
      [0.2126, 0.7152, 0.0722].reduce((s, w, i) => {
        const x = c[i]! / 255;
        return s + w * (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
      }, 0);
    const contrast = (el: Element): number => {
      const bg = bgOf(el);
      const [a, b] = [lum(over(parse(getComputedStyle(el).color), bg)), lum(bg)].sort((x, y) => y - x) as [number, number];
      return (a + 0.05) / (b + 0.05);
    };
    return [...document.querySelectorAll("select")].map((s) => ({
      id: s.id,
      scheme: getComputedStyle(s).colorScheme,
      appearance: getComputedStyle(s).appearance,
      field: contrast(s),
      options: [...s.options].map((o) => {
        const cs = getComputedStyle(o);
        return { label: o.label, scheme: cs.colorScheme, bgAlpha: parse(cs.backgroundColor)[3], contrast: contrast(o), opacity: Number(cs.opacity), disabled: o.disabled };
      }),
    }));
  });
}

// Mean relative luminance of a window rectangle, from the real rendered pixels.
async function windowLuminance(app: ElectronApplication, rect: { x: number; y: number; width: number; height: number }, save: string | null): Promise<number> {
  return app.evaluate(
    async ({ BrowserWindow }, [r, file]) => {
      const img = await BrowserWindow.getAllWindows()[0]!.webContents.capturePage({
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
      if (file) process.getBuiltinModule("node:fs").writeFileSync(file, img.toPNG());
      const px = img.toBitmap(); // BGRA
      const f = (v: number): number => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += 0.2126 * f(px[i + 2]!) + 0.7152 * f(px[i + 1]!) + 0.0722 * f(px[i]!);
      return sum / (px.length / 4);
    },
    [rect, save] as const,
  );
}

// A locator's box, or a clear failure naming what's missing (not a null dereference).
async function boxOf(loc: Locator, what: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await loc.boundingBox();
  expect(b, `${what} has no box on screen`).not.toBeNull();
  return b!;
}

test("P4: every dropdown follows the theme, shut and open, in light and dark", async () => {
  test.setTimeout(180_000);
  const dir = mkdtempSync(path.join(tmpdir(), "skovern-e2e-"));
  // Ollama installed, with a launch choice already made: Settings shows its dropdown too.
  writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ ollamaLaunch: "never", autoUpdates: true }));
  const shots = process.env["SKOVERN_SHOTS"] ?? null;
  const { app, page } = await launch(dir, { SKOVERN_OLLAMA_INSTALLED: "1" });
  try {
    const check = (where: string, list: SelectReport[], scheme: "light" | "dark"): void => {
      for (const s of list) {
        const at = `${where} #${s.id}`;
        expect(s.scheme, `${at}: color-scheme`).toBe(scheme);
        expect(s.appearance, `${at}: the list is drawn in the page`).toBe("base-select");
        expect(s.field, `${at}: field text contrast`).toBeGreaterThanOrEqual(4.5);
        expect(s.options.length, at).toBeGreaterThan(1);
        for (const o of s.options) {
          expect(o.scheme, `${at} "${o.label}": color-scheme`).toBe(scheme);
          expect(o.bgAlpha, `${at} "${o.label}": an opaque, explicit background`).toBe(1);
          expect(o.disabled, `${at} "${o.label}": not disabled`).toBe(false);
          expect(o.opacity, `${at} "${o.label}": not faded`).toBe(1);
          expect(o.contrast, `${at} "${o.label}": text contrast`).toBeGreaterThanOrEqual(4.5);
        }
      }
    };
    // Onboarding (the sign-in screen) has no dropdowns today; any it gains are checked too.
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      check(`onboarding ${scheme}`, await selects(page), scheme);
    }
    await signIn(page);
    await nav(page, "Settings").click();
    await expect(page.locator("select#brain")).toBeVisible();
    await expect(page.locator("select#ollama-launch")).toBeVisible();
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(150);
      const list = await selects(page);
      expect(list.map((s) => s.id).sort()).toEqual(expect.arrayContaining(["brain", "ollama-launch"]));
      check(`Settings ${scheme}`, list, scheme);

      for (const id of ["brain", "ollama-launch"]) {
        const at = `${scheme} #${id}`;
        // Open it: the list is really drawn, in the theme's colors, inside the field's card.
        const field = page.locator(`select#${id}`);
        await field.scrollIntoViewIfNeeded();
        await field.click();
        await expect.poll(() => field.evaluate((s) => s.matches(":open")), `${at}: opens`).toBe(true);
        await page.waitForTimeout(300); // let the opening fade finish
        const options = page.locator(`select#${id} option`);
        const first = await boxOf(options.first(), `${at}: the open list's first option`);
        const last = await boxOf(options.last(), `${at}: the open list's last option`);
        expect(first.height, `${at}: the open list is on screen`).toBeGreaterThan(10);
        const card = await boxOf(field.locator("xpath=ancestor::*[contains(concat(' ', @class, ' '), ' g-card ')][1]"), `${at}: the field's card`);
        expect(first.x, `${at}: the list starts inside its card`).toBeGreaterThanOrEqual(card.x - 1);
        expect(first.x + first.width, `${at}: the list ends inside its card`).toBeLessThanOrEqual(card.x + card.width + 1);
        const listBox = { x: first.x, y: first.y, width: first.width, height: last.y + last.height - first.y };
        if (shots) await windowLuminance(app, listBox, path.join(shots, `select-open-${scheme}-${id}-list.png`));
        // The list's own color: a row that isn't the picked one (that row wears the highlight).
        const plain = await boxOf(page.locator(`select#${id} option:not(:checked)`).first(), `${at}: an unpicked option`);
        const lum = await windowLuminance(app, plain, null);
        if (shots) {
          // The field and its open list (it opens above the field when there's no room below).
          const f = await boxOf(field, `${at}: the field`);
          const top = Math.max(0, Math.min(f.y, first.y) - 24);
          const bottom = Math.max(f.y + f.height, last.y + last.height) + 24;
          const left = Math.max(0, Math.min(f.x, first.x) - 24);
          const right = Math.max(f.x + f.width, first.x + first.width) + 24;
          await windowLuminance(app, { x: left, y: top, width: right - left, height: bottom - top }, path.join(shots, `select-open-${scheme}-${id}.png`));
        }
        if (scheme === "dark") expect(lum, `${at}: the open list is dark`).toBeLessThan(0.2);
        else expect(lum, `${at}: the open list is light`).toBeGreaterThan(0.6);

        // The keyboard still drives it: Escape closes without changing the pick.
        const before = await field.inputValue();
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Escape");
        await expect.poll(() => field.evaluate((s) => s.matches(":open")), `${at}: Escape closes it`).toBe(false);
        expect(await field.inputValue(), `${at}: Escape keeps the pick`).toBe(before);
      }
    }
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
