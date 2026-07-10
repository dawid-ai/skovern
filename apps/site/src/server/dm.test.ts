import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, expect, it } from "vitest";

// Metric for loop 006: boot the REAL entrypoint and prove the founder-DM path
// end to end — session-guarded send, out-of-band forward, token-guarded admin
// thread, and HTML escaping of stored message bodies.

const mainPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "main.ts");
const ADMIN_PW = "dm-loop-test-pw";

let container: StartedPostgreSqlContainer;
let child: ChildProcess;
let output = "";

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
});

afterAll(async () => {
  child?.kill();
  await container?.stop();
});

async function waitFor(re: RegExp, label: string, timeoutMs = 30_000): Promise<RegExpMatchArray> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = output.match(re);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}. Server output so far:\n${output}`);
}

function basic(password: string): string {
  return "Basic " + Buffer.from(`admin:${password}`).toString("base64");
}

async function signIn(base: string, email: string): Promise<string> {
  await fetch(`${base}/auth/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const link = await waitFor(
    new RegExp(`Sign-in link for ${email.replace(/[.@]/g, "\\$&")}:\\s*(\\S+)`),
    "printed magic link",
  );
  const token = new URL(link[1]!).searchParams.get("token")!;
  const res = await fetch(`${base}/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return ((await res.json()) as { session: string }).session;
}

it("guards DM send by session, forwards it, and serves an escaped admin thread", async () => {
  child = spawn(process.execPath, ["--import", "tsx", mainPath], {
    env: {
      ...process.env,
      DATABASE_URL: container.getConnectionUri(),
      PORT: "0",
      RESEND_API_KEY: "",
      DESKHAND_ADMIN_TOKEN: ADMIN_PW,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (output += d.toString()));

  const listening = await waitFor(/listening on (http:\/\/127\.0\.0\.1:\d+)/, "listening line");
  const base = listening[1]!;

  // 1. no session → 401
  const anon = await fetch(`${base}/dm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
  expect(anon.status).toBe(401);

  // 2. sign in, then POST /dm with the session → 200, and the forward fires
  const session = await signIn(base, "florist@shop.test");
  const hostileBody = "please help <script>alert(1)</script>";
  const sent = await fetch(`${base}/dm`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
    body: JSON.stringify({ message: hostileBody }),
  });
  expect(sent.status).toBe(200);
  // the forward channel (ConsoleNotifier in this env) was called with the body
  await waitFor(/\[dm\] new message.*please help <script>/, "forward log line");

  // 3. admin thread: wrong token → 401
  const wrong = await fetch(`${base}/admin/dm`, { headers: { authorization: basic("nope") } });
  expect(wrong.status).toBe(401);

  // 4. admin thread: right token → 200 HTML containing the message, ESCAPED
  const ok = await fetch(`${base}/admin/dm`, { headers: { authorization: basic(ADMIN_PW) } });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toMatch(/text\/html/);
  const html = await ok.text();
  expect(html).toContain("florist@shop.test");
  expect(html).toContain("&lt;script&gt;"); // escaped
  expect(html).not.toContain("<script>alert(1)</script>"); // never raw

  // 5. admin news publish: wrong token → 401; right token → post appears on /news
  const badPublish = await fetch(`${base}/admin/news`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: basic("nope") },
    body: JSON.stringify({ slug: "x", title: "x", body: "x" }),
  });
  expect(badPublish.status).toBe(401);

  const published = await fetch(`${base}/admin/news`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: basic(ADMIN_PW) },
    body: JSON.stringify({ slug: "loop-006", title: "Founder DM is live", body: "Say hi anytime." }),
  });
  expect(published.status).toBe(200);

  const feed = await fetch(`${base}/news`);
  const posts = ((await feed.json()) as { posts: { slug: string }[] }).posts;
  expect(posts.map((p) => p.slug)).toContain("loop-006");

  // 6. two-way chat: the user's own thread shows their message, unread 0
  const bearer = { authorization: `Bearer ${session}` };
  type Thread = { messages: { sender: string; body: string }[]; unread: number };
  const t1 = (await (await fetch(`${base}/dm/thread`, { headers: bearer })).json()) as Thread;
  expect(t1.messages.some((m) => m.sender === "user")).toBe(true);
  expect(t1.unread).toBe(0);

  // 7. the founder replies via the admin form endpoint (accountId from the admin HTML)
  const accountId = /name="accountId" value="([^"]+)"/.exec(html)![1]!;
  const replyForm = new URLSearchParams({ accountId, body: "Thanks for reaching out!" }).toString();
  const formHeaders = { "content-type": "application/x-www-form-urlencoded" };
  const replyBad = await fetch(`${base}/admin/dm/reply`, {
    method: "POST",
    headers: { ...formHeaders, authorization: basic("nope") },
    body: replyForm,
  });
  expect(replyBad.status).toBe(401);
  const reply = await fetch(`${base}/admin/dm/reply`, {
    method: "POST",
    headers: { ...formHeaders, authorization: basic(ADMIN_PW) },
    body: replyForm,
    redirect: "manual",
  });
  expect([302, 303]).toContain(reply.status);

  // 8. the reply shows up in the user's thread as a founder message; unread now 1
  const t2 = (await (await fetch(`${base}/dm/thread`, { headers: bearer })).json()) as Thread;
  expect(t2.messages.some((m) => m.sender === "founder" && m.body === "Thanks for reaching out!")).toBe(true);
  expect(t2.unread).toBe(1);

  // 9. mark read → unread clears
  expect((await fetch(`${base}/dm/read`, { method: "POST", headers: bearer })).status).toBe(200);
  const t3 = (await (await fetch(`${base}/dm/thread`, { headers: bearer })).json()) as Thread;
  expect(t3.unread).toBe(0);

  // 10. isolation: a different account sees NONE of the first account's thread
  const otherSession = await signIn(base, "someone-else@shop.test");
  const other = (await (
    await fetch(`${base}/dm/thread`, { headers: { authorization: `Bearer ${otherSession}` } })
  ).json()) as Thread;
  expect(other.messages).toHaveLength(0);
  expect(other.unread).toBe(0);

  child.kill("SIGTERM");
});
