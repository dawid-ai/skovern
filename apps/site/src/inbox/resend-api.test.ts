import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeResend } from "../../scripts/smoke/fake-resend.js";
import { authResults, getReceivedEmail, headerValue } from "./resend-api.js";

// The Receiving API's shapes we read defensively (loop 055 checker note 1):
// headers as a map or a list, any name case; authentication missing or odd.

const ID = "99999999-0000-4000-8000-000000000001";
const fake = new FakeResend();
let api = { baseUrl: "", apiKey: "re_test" };

beforeAll(async () => {
  api = { baseUrl: (await fake.listen()).url, apiKey: "re_test" };
});
afterAll(() => fake.close());

describe("headerValue", () => {
  it("reads a map with any name case, and an array value's first entry", () => {
    expect(headerValue({ "AUTO-SUBMITTED": "auto-replied" }, "auto-submitted")).toBe("auto-replied");
    expect(headerValue({ "Auto-Submitted": ["auto-generated", "x"] }, "auto-submitted")).toBe("auto-generated");
  });

  it("reads a list of { name, value } with any name case", () => {
    expect(headerValue([{ name: "From", value: "a" }, { name: "auto-SUBMITTED", value: "no" }], "auto-submitted")).toBe("no");
  });

  it("finds nothing in other shapes", () => {
    for (const h of [null, "auto-submitted: auto-replied", 3, [{ value: "auto-replied" }], { other: "x" }]) {
      expect(headerValue(h, "auto-submitted")).toBeNull();
    }
  });
});

describe("authResults", () => {
  it("lowercases results and treats a missing or empty block as no data", () => {
    expect(authResults({ spf: "PASS", dkim: " Fail ", dmarc: "Gray" })).toEqual({ spf: "pass", dkim: "fail", dmarc: "gray" });
    for (const raw of [undefined, null, "pass", [], {}, { spf: "", dkim: null }]) expect(authResults(raw)).toBeNull();
  });
});

describe("getReceivedEmail", () => {
  it("reads Auto-Submitted: no from either header shape", async () => {
    for (const headers of [{ "auto-submitted": "no" }, [{ name: "Auto-Submitted", value: "no" }]]) {
      fake.inbound.set(ID, { id: ID, from: "a@b.test", to: [], headers, authentication: { spf: "PASS" }, attachments: [] });
      const e = await getReceivedEmail(api, ID);
      expect(e.autoSubmitted).toBe("no");
      expect(e.authentication).toEqual({ spf: "pass", dkim: null, dmarc: null });
    }
  });
});
