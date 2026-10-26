import { describe, expect, it } from "vitest";
import { checkDetails, checkSignup, checkUrl } from "./validate.js";
import { csvCell, toCsv } from "./admin.js";

const TOKEN = "a".repeat(43);

describe("checkSignup", () => {
  it("normalizes the email and tidies the name", () => {
    const r = checkSignup({ name: "  Rosa   Diaz ", email: " Rosa@Bloom.Shop " });
    expect(r).toEqual({ ok: true, value: { name: "Rosa Diaz", email: "rosa@bloom.shop", bot: false } });
  });

  it.each([
    [{ email: "a@b.co" }, "name", "Tell us what to call you."],
    [{ name: "x".repeat(81), email: "a@b.co" }, "name", "That name is a bit long. A first name is plenty."],
    [{ name: "Ro\u0007sa", email: "a@b.co" }, "name", "Use just letters in your name, please."],
    [{ name: "Rosa <b>hi</b>", email: "a@b.co" }, "name", "Use just letters in your name, please."],
    [{ name: "Win at https://x.co", email: "a@b.co" }, "name", "Use just letters in your name, please."],
    [{ name: "Visit bloom.shop now", email: "a@b.co" }, "name", "That looks like a web address. Just your name, please."],
    [{ name: "evil.com", email: "a@b.co" }, "name", "That looks like a web address. Just your name, please."],
    [{ name: "evil .com", email: "a@b.co" }, "name", "That looks like a web address. Just your name, please."],
    [{ name: "Go to EVIL.COM", email: "a@b.co" }, "name", "That looks like a web address. Just your name, please."],
    [{ name: "bloom.florist", email: "a@b.co" }, "name", "That looks like a web address. Just your name, please."],
    [{ name: "Your refund is ready at refund.icu", email: "a@b.co" }, "name", "That looks like a web address. Just your name, please."],
    [{ name: "Claim at Refund.ICU", email: "a@b.co" }, "name", "That looks like a web address. Just your name, please."],
    [{ name: "Hi see paypal-help.club", email: "a@b.co" }, "name", "That looks like a web address. Just your name, please."],
    [{ name: "Verify at secure.login.vip now", email: "a@b.co" }, "name", "That looks like a web address. Just your name, please."],
    [{ name: "...", email: "a@b.co" }, "name", "Use just letters in your name, please."],
    [{ name: "' - .", email: "a@b.co" }, "name", "Use just letters in your name, please."],
    [{ name: "\u200C\u200C", email: "a@b.co" }, "name", "Use just letters in your name, please."],
    [{ name: "Rosa" }, "email", "We need an email to save your spot."],
    [{ name: "Rosa", email: "rosa@" }, "email", "That email looks off. Check for a typo?"],
    [{ name: "Rosa", email: `${"a".repeat(250)}@b.co` }, "email", "That email looks off. Check for a typo?"],
  ])("rejects %j on %s", (body, field, message) => {
    expect(checkSignup(body)).toEqual({ ok: false, error: { field, message } });
  });

  it("accepts an 80-character name", () => {
    expect(checkSignup({ name: "x".repeat(80), email: "a@b.co" }).ok).toBe(true);
  });

  it.each(["J.Smith", "Mary J.Blige", "mary j.blige", "Pay at x.bond today", "Mary J. Blige", "Saoirse O\u2019Neill", "Mehr\u200Cnaz", "مهر\u200Cناز", "A.J. Okafor", "St. Clair"])(
    "accepts initials and joiners: %s",
    (name) => expect(checkSignup({ name, email: "a@b.co" }).ok).toBe(true),
  );

  it.each(["Zoë O'Brien", "Anne-Marie", "José", "Dr. Ngozi", "Mary J. Blige","Łukasz", "Aná", "Saoirse O\u2019Neill"])(
    "accepts the real name %s",
    (name) => expect(checkSignup({ name, email: "a@b.co" }).ok).toBe(true),
  );

  it("flags a filled honeypot as a bot", () => {
    const r = checkSignup({ name: "Rosa", email: "a@b.co", company_website: "spam.biz" });
    expect(r.ok && r.value.bot).toBe(true);
  });
});

describe("checkUrl", () => {
  it.each([
    ["bloomandvine.shop", "https://bloomandvine.shop"],
    ["http://bloom.shop/menu", "http://bloom.shop/menu"],
    ["HTTPS://www.bloom.co.uk", "https://www.bloom.co.uk"],
  ])("accepts %s", (raw, value) => {
    expect(checkUrl(raw)).toEqual({ ok: true, value });
  });

  it.each(["javascript:alert(1)", "data:text/html,hi", "ftp://bloom.shop", "not a site", "https://", "x".repeat(201)])(
    "rejects %s",
    (raw) => {
      const r = checkUrl(raw);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.field).toBe("url");
    },
  );
});

describe("checkDetails", () => {
  it("keeps only answered fields", () => {
    expect(checkDetails({ detailsToken: TOKEN, businessType: "florist" })).toEqual({
      ok: true,
      value: { token: TOKEN, jobTitle: null, businessType: "florist", url: null },
    });
  });

  it.each([
    [{ detailsToken: "short", jobTitle: "Owner" }, "detailsToken"],
    [{ detailsToken: TOKEN, businessType: "casino" }, "businessType"],
    [{ detailsToken: TOKEN, jobTitle: "x".repeat(81) }, "jobTitle"],
    [{ detailsToken: TOKEN, url: "javascript:alert(1)" }, "url"],
    [{ detailsToken: TOKEN }, "jobTitle"],
    [{ detailsToken: TOKEN, jobTitle: 7 }, "jobTitle"],
  ])("rejects %j on %s", (body, field) => {
    const r = checkDetails(body);
    expect(!r.ok && r.error.field).toBe(field);
  });
});

describe("CSV export", () => {
  it.each(["=HYPERLINK(1)", "+1", "-2", "@SUM(A1)", "\tx"])("neutralizes formula prefix in %j", (v) => {
    expect(csvCell(v)).toBe(`"'${v}"`);
  });

  it("quotes and escapes every cell", () => {
    const csv = toCsv([
      {
        number: 1,
        name: 'Rosa "Ro"',
        email: "rosa@bloom.shop",
        jobTitle: null,
        businessType: "florist",
        url: "https://bloom.shop",
        createdAt: "2026-10-26T10:00:00.000Z",
        welcome: "refused",
      },
    ]);
    expect(csv.split("\r\n")[1]).toBe(
      `"1","Rosa ""Ro""","rosa@bloom.shop","","florist","https://bloom.shop","2026-10-26T10:00:00.000Z","refused"`,
    );
  });
});
