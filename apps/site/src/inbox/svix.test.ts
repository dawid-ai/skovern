import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TOLERANCE_SECONDS, verifySvix } from "./svix.js";

// Svix's published example (docs.svix.com/receiving/verifying-payloads/how-manual).
const KEY = Buffer.from("plJ3nmyCDGBKInavdOK15jsl", "base64");
const BODY = '{"event_type":"ping","data":{"success":true}}';
const ID = "msg_loFOjxBNrRLzqYUf";
const TS = "1731705121";
const SIG = "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=";
const AT = Number(TS) * 1000;

describe("verifySvix", () => {
  it("accepts Svix's own example signature", () => {
    expect(verifySvix(KEY, { id: ID, timestamp: TS, signature: SIG }, BODY, AT)).toBe("ok");
  });

  it("finds the right entry among several, and ignores other versions", () => {
    const signature = `v2,${SIG.slice(3)} v1,AAAA ${SIG}`;
    expect(verifySvix(KEY, { id: ID, timestamp: TS, signature }, BODY, AT)).toBe("ok");
    expect(verifySvix(KEY, { id: ID, timestamp: TS, signature: `v2,${SIG.slice(3)}` }, BODY, AT)).toBe("bad-signature");
  });

  it("refuses a tampered body, ID, or timestamp", () => {
    expect(verifySvix(KEY, { id: ID, timestamp: TS, signature: SIG }, BODY.replace("true", "false"), AT)).toBe("bad-signature");
    expect(verifySvix(KEY, { id: `${ID}x`, timestamp: TS, signature: SIG }, BODY, AT)).toBe("bad-signature");
    expect(verifySvix(KEY, { id: ID, timestamp: String(Number(TS) + 1), signature: SIG }, BODY, AT)).toBe("bad-signature");
  });

  it("refuses the right message signed with another key", () => {
    const other = createHmac("sha256", Buffer.from("another-key-entirely")).update(`${ID}.${TS}.${BODY}`).digest("base64");
    expect(verifySvix(KEY, { id: ID, timestamp: TS, signature: `v1,${other}` }, BODY, AT)).toBe("bad-signature");
  });

  it("refuses a timestamp more than five minutes off, either way", () => {
    const h = { id: ID, timestamp: TS, signature: SIG };
    expect(verifySvix(KEY, h, BODY, AT + TOLERANCE_SECONDS * 1000)).toBe("ok");
    expect(verifySvix(KEY, h, BODY, AT + 6 * 60_000)).toBe("stale");
    expect(verifySvix(KEY, h, BODY, AT - 6 * 60_000)).toBe("stale");
  });

  it("refuses a missing or malformed header", () => {
    expect(verifySvix(KEY, { id: undefined, timestamp: TS, signature: SIG }, BODY, AT)).toBe("missing");
    expect(verifySvix(KEY, { id: ID, timestamp: undefined, signature: SIG }, BODY, AT)).toBe("missing");
    expect(verifySvix(KEY, { id: ID, timestamp: TS, signature: "" }, BODY, AT)).toBe("missing");
    expect(verifySvix(KEY, { id: ID, timestamp: "1731705121.5", signature: SIG }, BODY, AT)).toBe("missing");
  });
});
