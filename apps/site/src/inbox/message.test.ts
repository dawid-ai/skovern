import { describe, expect, it } from "vitest";
import { buildForward, INBOX_FROM, MAX_ATTACHMENT_BYTES, MAX_HTML_CHARS, senderAddress } from "./message.js";
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
  ...over,
});
const opts = { forwardTo: "dawid@inbox.test", links: new Map<string, string>(), withAttachments: true };

describe("buildForward", () => {
  it("sends from the inbox address to FORWARD_TO, replying to the sender", () => {
    const m = buildForward(email(), opts);
    expect(m).toMatchObject({ from: INBOX_FROM, to: "dawid@inbox.test", reply_to: "rosa@bloom.test", subject: "[skovern.com] Hello there" });
    expect(m.text).toBe("From: Rosa <rosa@bloom.test>\nTo: hi@skovern.com\n\nDo you do weddings?");
    expect(m.tags).toEqual([{ name: "kind", value: "forward" }]);
  });

  it("puts the original To and Cc at the top, in text and escaped HTML", () => {
    const m = buildForward(email({ cc: ["Kim <kim@bloom.test>"], html: "<p>Hi</p>" }), opts);
    expect(m.text.split("\n").slice(0, 3)).toEqual(["From: Rosa <rosa@bloom.test>", "To: hi@skovern.com", "Cc: Kim <kim@bloom.test>"]);
    expect(m.html).toContain("Cc: Kim &lt;kim@bloom.test&gt;");
    expect(m.html?.endsWith("<p>Hi</p>")).toBe(true);
  });

  it("flags a failed SPF, DKIM, or DMARC check with [spam?], and still forwards", () => {
    for (const k of ["spf", "dkim", "dmarc"] as const) {
      const auth = { spf: "pass", dkim: "pass", dmarc: "pass", [k]: "fail" };
      expect(buildForward(email({ authentication: auth }), opts).subject).toBe("[spam?] [skovern.com] Hello there");
    }
    expect(buildForward(email({ authentication: { spf: "gray", dkim: "gray", dmarc: null } }), opts).subject).toBe("[skovern.com] Hello there");
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
