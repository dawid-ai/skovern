import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleRequestLink, handleVerify } from "./handlers.js";
import { ConsoleMailer } from "./mailer.js";
import { startAuthServer } from "./server.js";
import { AuthService } from "./service.js";
import { AuthStore } from "./store.js";
import { createOpaqueToken } from "./tokens.js";

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await new AuthStore(pool).migrate();
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await pool.query("TRUNCATE accounts, magic_tokens, sessions RESTART IDENTITY CASCADE");
  await pool.query("ALTER SEQUENCE deskhand_og_seq RESTART WITH 1");
});

function makeService(): { service: AuthService; mailer: ConsoleMailer } {
  const mailer = new ConsoleMailer();
  const service = new AuthService(new AuthStore(pool), mailer, { appUrl: "https://app.test" });
  return { service, mailer };
}

function tokenFromUrl(url: string): string {
  const raw = new URL(url).searchParams.get("token");
  if (!raw) throw new Error("no token in url");
  return raw;
}

describe("magic-link auth", () => {
  it("stores only a hash of the token, never the plaintext secret", async () => {
    const { service, mailer } = makeService();
    await service.requestMagicLink("florist@shop.test");
    const token = tokenFromUrl(mailer.sent[0]!.url);

    const { rows } = await pool.query<{ id: string; secret_hash: string }>(
      "SELECT id, secret_hash FROM magic_tokens",
    );
    const stored = rows[0]!;
    // The secret half of the token appears nowhere in the row.
    const secret = token.split(".")[1]!;
    expect(secret.length).toBeGreaterThan(0);
    expect(stored.secret_hash).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  it("verifies a valid link, creating the account with OG #1 and a session", async () => {
    const { service, mailer } = makeService();
    await service.requestMagicLink("florist@shop.test");
    const session = await service.verifyMagicLink(tokenFromUrl(mailer.sent[0]!.url));

    expect(session).not.toBeNull();
    expect(session!.ogNumber).toBe(1);
    expect(session!.email).toBe("florist@shop.test");
    expect(session!.token).toMatch(/.+\..+/);
  });

  it("keeps the same permanent OG number when the same person signs in again", async () => {
    const { service, mailer } = makeService();

    await service.requestMagicLink("florist@shop.test");
    const first = await service.verifyMagicLink(tokenFromUrl(mailer.sent[0]!.url));

    await service.requestMagicLink("florist@shop.test");
    const second = await service.verifyMagicLink(tokenFromUrl(mailer.sent[1]!.url));

    expect(first!.ogNumber).toBe(1);
    expect(second!.ogNumber).toBe(1);
    expect(second!.accountId).toBe(first!.accountId);
  });

  it("rejects reused, expired, and garbage tokens", async () => {
    const { service, mailer } = makeService();

    // reused: a token verifies once, then never again
    await service.requestMagicLink("a@shop.test");
    const good = tokenFromUrl(mailer.sent[0]!.url);
    expect(await service.verifyMagicLink(good)).not.toBeNull();
    expect(await service.verifyMagicLink(good)).toBeNull();

    // expired: token whose lifetime already passed
    const store = new AuthStore(pool);
    const expired = createOpaqueToken();
    await store.insertMagicToken({
      id: expired.id,
      secretHash: expired.secretHash,
      email: "b@shop.test",
      ttlMinutes: -1,
    });
    expect(await service.verifyMagicLink(expired.full)).toBeNull();

    // garbage: never issued
    expect(await service.verifyMagicLink("not-a-real.token")).toBeNull();
    expect(await service.verifyMagicLink("missing-secret")).toBeNull();
  });

  it("does not burn a token when the secret is wrong", async () => {
    const { service, mailer } = makeService();
    await service.requestMagicLink("c@shop.test");
    const good = tokenFromUrl(mailer.sent[0]!.url);
    const id = good.split(".")[0]!;

    // wrong secret, right id — must fail and must NOT consume the token
    expect(await service.verifyMagicLink(`${id}.wrongsecret`)).toBeNull();
    // the real link still works afterward
    expect(await service.verifyMagicLink(good)).not.toBeNull();
  });

  it("assigns OG numbers 1..N under concurrent first-time verifies (distinct emails)", async () => {
    const N = 8;
    const { service, mailer } = makeService();
    for (let i = 0; i < N; i++) await service.requestMagicLink(`user${i}@shop.test`);

    const tokens = mailer.sent.map((s) => tokenFromUrl(s.url));
    const sessions = await Promise.all(tokens.map((t) => service.verifyMagicLink(t)));

    const ogs = sessions.map((s) => s!.ogNumber).sort((a, b) => a - b);
    expect(ogs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it("stays gap-free when the SAME new email is verified concurrently", async () => {
    const { service, mailer } = makeService();
    // two live links for one brand-new email, redeemed at the same time
    await service.requestMagicLink("dbl@shop.test");
    await service.requestMagicLink("dbl@shop.test");
    const [t1, t2] = mailer.sent.map((s) => tokenFromUrl(s.url));
    const [s1, s2] = await Promise.all([
      service.verifyMagicLink(t1!),
      service.verifyMagicLink(t2!),
    ]);

    // both links work and resolve to the SAME founding number
    expect(s1!.ogNumber).toBe(1);
    expect(s2!.ogNumber).toBe(1);
    // and no sequence value was burned: the next new account is #2, not #3
    await service.requestMagicLink("after@shop.test");
    const s3 = await service.verifyMagicLink(tokenFromUrl(mailer.sent[2]!.url));
    expect(s3!.ogNumber).toBe(2);
  });

  it("rejects every bad-token kind identically (no leak about which failed)", async () => {
    const { service, mailer } = makeService();
    await service.requestMagicLink("e@shop.test");
    const used = tokenFromUrl(mailer.sent[0]!.url);
    await service.verifyMagicLink(used); // consume it

    const reused = await handleVerify(service, { token: used });
    const garbage = await handleVerify(service, { token: "no.such" });
    const malformed = await handleVerify(service, { token: "missingsecret" });

    expect(reused).toEqual(garbage);
    expect(garbage).toEqual(malformed);
  });

  it("does not reveal whether an email already has an account", async () => {
    const { service } = makeService();
    // seed one known account
    await service.requestMagicLink("known@shop.test");

    const known = await handleRequestLink(service, { email: "known@shop.test" });
    const unknown = await handleRequestLink(service, { email: "stranger@shop.test" });

    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
  });

  it("returns a 401 for a bad verify and 200 with the session for a good one", async () => {
    const { service, mailer } = makeService();
    await service.requestMagicLink("d@shop.test");
    const token = tokenFromUrl(mailer.sent[0]!.url);

    const bad = await handleVerify(service, { token: "nope.nope" });
    expect(bad.status).toBe(401);

    const ok = await handleVerify(service, { token });
    expect(ok.status).toBe(200);
    expect((ok.body as { ogNumber: number }).ogNumber).toBe(1);
  });
});

describe("auth http server", () => {
  it("runs the full request→verify flow over real HTTP", async () => {
    const { service, mailer } = makeService();
    const srv = await startAuthServer({ service });
    try {
      const reqRes = await fetch(`${srv.url}/auth/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "http@shop.test" }),
      });
      expect(reqRes.status).toBe(200);

      const token = tokenFromUrl(mailer.sent[0]!.url);
      const verifyRes = await fetch(`${srv.url}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(verifyRes.status).toBe(200);
      const body = (await verifyRes.json()) as { ok: boolean; session: string; ogNumber: number };
      expect(body.ok).toBe(true);
      expect(body.ogNumber).toBe(1);
      expect(body.session).toMatch(/.+\..+/);
    } finally {
      await srv.close();
    }
  });

  it("rejects unknown routes and non-POST methods without leaking", async () => {
    const { service } = makeService();
    const srv = await startAuthServer({ service });
    try {
      expect((await fetch(`${srv.url}/nope`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`${srv.url}/auth/verify`, { method: "GET" })).status).toBe(405);
      const bad = await fetch(`${srv.url}/auth/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      expect(bad.status).toBe(400);
    } finally {
      await srv.close();
    }
  });
});
