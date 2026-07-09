import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleRequestLink, handleVerify } from "./handlers.js";
import { ConsoleMailer } from "./mailer.js";
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

  it("assigns gap-free OG numbers under concurrent first-time verifies", async () => {
    const N = 8;
    const { service, mailer } = makeService();
    for (let i = 0; i < N; i++) await service.requestMagicLink(`user${i}@shop.test`);

    const tokens = mailer.sent.map((s) => tokenFromUrl(s.url));
    const sessions = await Promise.all(tokens.map((t) => service.verifyMagicLink(t)));

    const ogs = sessions.map((s) => s!.ogNumber).sort((a, b) => a - b);
    expect(ogs).toEqual(Array.from({ length: N }, (_, i) => i + 1));
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
