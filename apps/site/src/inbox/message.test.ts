import { describe, expect, it } from "vitest";
import {
  buildForward,
  inboxFrom,
  isAutoSubmitted,
  looksSpoofed,
  MAX_ATTACHMENT_BYTES,
  MAX_HTML_CHARS,
  senderAddress,
} from "./message.js";
import type { ReceivedEmail } from "./resend-api.js";

const email = (over: Partial<ReceivedEmail> = {}): ReceivedEmail => ({
  id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
  from: "Rosa <rosa@bloom.test>",
  to: ["hi@skovern.com"],
  cc: [],
  replyTo: [],
  subject: "Hello there",
  text: "Do you do weddings?",
  html: null,
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  attachments: [],
  autoSubmitted: null,
  ...over,
});
const FROM = inboxFrom("in.skovern.com");
const opts = { from: FROM, forwardTo: "dawid@inbox.test", links: new Map<string, string>(), withAttachments: true };

describe("buildForward", () => {
  it("sends from the inbox subdomain to FORWARD_TO, replying to the sender, marked machine-sent", () => {
    const m = buildForward(email(), opts);
    expect(FROM).toBe("Skovern inbox <inbox@in.skovern.com>");
    expect(m.headers).toEqual({ "Auto-Submitted": "auto-generated" });
    expect(m).toMatchObject({ from: FROM, to: "dawid@inbox.test", reply_to: "rosa@bloom.test", subject: "[skovern.com] Hello there" });
    expect(m.text).toBe("From: Rosa <rosa@bloom.test>\nTo: hi@skovern.com\n\nDo you do weddings?");
    expect(m.tags).toEqual([{ name: "kind", value: "forward" }]);
  });

  it("puts the original To and Cc at the top, in text and escaped HTML", () => {
    const m = buildForward(email({ cc: ["Kim <kim@bloom.test>"], html: "<p>Hi</p>" }), opts);
    expect(m.text.split("\n").slice(0, 3)).toEqual(["From: Rosa <rosa@bloom.test>", "To: hi@skovern.com", "Cc: Kim <kim@bloom.test>"]);
    expect(m.html).toContain("Cc: Kim &lt;kim@bloom.test&gt;");
    expect(m.html?.endsWith("<p>Hi</p>")).toBe(true);
  });

  it("S1: trusts the sender only when SPF or DKIM passed and DMARC didn't fail", () => {
    const auth = (spf: string | null, dkim: string | null, dmarc: string | null): ReceivedEmail =>
      email({ authentication: { spf, dkim, dmarc } });
    const cases: [string, ReceivedEmail, boolean][] = [
      ["all pass", auth("pass", "pass", "pass"), false],
      ["SPF pass only, no DMARC policy", auth("pass", "gray", "gray"), false],
      ["DKIM pass only", auth("fail", "pass", null), false],
      ["softfail and unsigned (gray)", auth("gray", "gray", "gray"), true],
      ["none at all (null results)", auth(null, null, null), true],
      ["SPF pass but DMARC fail", auth("pass", "gray", "fail"), true],
      ["checks errored", auth("processing_failed", "unknown", "unknown"), true],
      ["no authentication reported", email({ authentication: null }), true],
    ];
    for (const [label, e, spoofed] of cases) {
      expect(looksSpoofed(e), label).toBe(spoofed);
      expect(buildForward(e, opts).subject.startsWith("[spam?] "), label).toBe(spoofed);
    }
  });

  it("S1: shows Reply-To in the banner when it differs from the sender", () => {
    const m = buildForward(email({ replyTo: ["Orders <orders@bloom.test>"], html: "<p>x</p>" }), opts);
    expect(m.text.split("\n").slice(0, 3)).toEqual(["From: Rosa <rosa@bloom.test>", "Reply-To: orders@bloom.test", "To: hi@skovern.com"]);
    expect(m.html).toContain("Reply-To: orders@bloom.test");
    expect(buildForward(email({ replyTo: ["ROSA@bloom.test"] }), opts).text).not.toContain("Reply-To:");
  });

  it("S4: spots Auto-Submitted mail, except Auto-Submitted: no", () => {
    expect(isAutoSubmitted(email({ autoSubmitted: "auto-replied" }))).toBe(true);
    expect(isAutoSubmitted(email({ autoSubmitted: " Auto-Generated; foo" }))).toBe(true);
    expect(isAutoSubmitted(email({ autoSubmitted: "no" }))).toBe(false);
    expect(isAutoSubmitted(email())).toBe(false);
  });

  it("S4: keeps a valid attachment type and inline ID, and drops invalid ones", () => {
    const links = new Map([["a1", "https://cdn.test/a1"], ["a2", "https://cdn.test/a2"]]);
    const attachments = [
      { id: "a1", filename: "x.png", contentType: "image/png", contentId: "<img.001@bloom>", size: 1 },
      { id: "a2", filename: "y.bin", contentType: "text/html\r\nX-Evil: 1", contentId: "a b\"<c>", size: 1 },
    ];
    expect(buildForward(email({ attachments }), { ...opts, links }).attachments).toEqual([
      { filename: "x.png", path: "https://cdn.test/a1", content_type: "image/png", content_id: "img.001@bloom" },
      { filename: "y.bin", path: "https://cdn.test/a2" },
    ]);
  });

  it("keeps a subject to one line and names an empty one", () => {
    expect(buildForward(email({ subject: "a\r\nBcc: x@evil.test" }), opts).subject).toBe("[skovern.com] a Bcc: x@evil.test");
    expect(buildForward(email({ subject: "" }), opts).subject).toBe("[skovern.com] (no subject)");
  });

  it("replies to the message's own Reply-To when it's one plain outside address", () => {
    expect(buildForward(email({ replyTo: ["Orders <orders@bloom.test>"] }), opts).reply_to).toBe("orders@bloom.test");
    expect(buildForward(email({ replyTo: ["a@bloom.test", "b@bloom.test"] }), opts).reply_to).toBe("rosa@bloom.test");
    expect(buildForward(email({ replyTo: ["hi@skovern.com"] }), opts).reply_to).toBe("rosa@bloom.test");
    expect(buildForward(email({ replyTo: ["two words"] }), opts).reply_to).toBe("rosa@bloom.test");
  });

  it("leaves Reply-To off when the sender isn't one plain address", () => {
    expect(buildForward(email({ from: "nobody" }), opts).reply_to).toBeUndefined();
    expect(senderAddress("a@b.test, c@d.test")).toBeNull();
    expect(senderAddress("<x@y.test>")).toBe("x@y.test");
  });

  it("attaches every file by its signed link, keeping inline image IDs", () => {
    const attachments = [
      { id: "a1", filename: "logo.png", contentType: "image/png", contentId: "<img001>", size: 4096 },
      { id: "a2", filename: "quote.pdf", contentType: "application/pdf", contentId: null, size: 13264 },
    ];
    const links = new Map([["a1", "https://cdn.test/a1"], ["a2", "https://cdn.test/a2"]]);
    expect(buildForward(email({ attachments }), { ...opts, links }).attachments).toEqual([
      { filename: "logo.png", path: "https://cdn.test/a1", content_type: "image/png", content_id: "img001" },
      { filename: "quote.pdf", path: "https://cdn.test/a2", content_type: "application/pdf" },
    ]);
  });

  it("lists files by name when they're too big, a link is missing, or attachments are off", () => {
    const big = [{ id: "a1", filename: "video.mov", contentType: null, contentId: null, size: MAX_ATTACHMENT_BYTES + 1 }];
    const links = new Map([["a1", "https://cdn.test/a1"]]);
    for (const m of [
      buildForward(email({ attachments: big }), { ...opts, links }),
      buildForward(email({ attachments: [{ ...big[0]!, size: 10 }] }), opts),
      buildForward(email({ attachments: [{ ...big[0]!, size: 10 }] }), { ...opts, links, withAttachments: false }),
    ]) {
      expect(m.attachments).toBeUndefined();
      expect(m.text).toContain("Attachments not forwarded");
      expect(m.text).toContain("- video.mov (");
    }
  });

  it("drops an HTML part that's too big, keeping the text", () => {
    const m = buildForward(email({ html: "x".repeat(MAX_HTML_CHARS + 1) }), opts);
    expect(m.html).toBeUndefined();
    expect(m.text).toContain("too big to forward");
  });
});
