import type { ResendAttachment, ResendEmail } from "../auth/mailer.js";
import { isOwnDomain, PLAIN_ADDRESS } from "../server/config.js";
import type { ReceivedEmail } from "./resend-api.js";

// Builds the forward of one received email (pure, no I/O). The recipient is
// the configured FORWARD_TO, never anything in the email or the webhook.

export const INBOX_FROM = "Skovern inbox <inbox@skovern.com>";
export const FORWARD_TAG = "forward";

/** Resend takes up to 40 MB of attachments per email after base64, which grows
 *  them by a third. Kept well under, so the body fits too. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** An HTML body bigger than this is dropped; the text part still goes. */
export const MAX_HTML_CHARS = 4 * 1024 * 1024;
const MAX_TEXT_CHARS = 1024 * 1024;
const MAX_SUBJECT_CHARS = 900;

/** The bare address in `Name <a@b.c>` or `a@b.c`, or null if it isn't one. */
export function senderAddress(from: string): string | null {
  const bracketed = /<([^<>]+)>\s*$/.exec(from)?.[1];
  const address = (bracketed ?? from).trim();
  return PLAIN_ADDRESS.test(address) ? address : null;
}

/** Where Reply goes: the message's own Reply-To when it's one plain address
 *  outside skovern.com, else the sender. Null when neither is usable. */
export function replyAddress(e: ReceivedEmail): string | null {
  const only = e.replyTo.length === 1 ? senderAddress(e.replyTo[0] ?? "") : null;
  if (only && !isOwnDomain(only)) return only;
  return senderAddress(e.from);
}

/** SPF or DKIM failed (DMARC too): forwarded anyway, but flagged. */
export function looksSpoofed(e: ReceivedEmail): boolean {
  const a = e.authentication;
  return a !== null && (a.spf === "fail" || a.dkim === "fail" || a.dmarc === "fail");
}

const oneLine = (s: string): string => s.replace(/[\r\n\t]+/g, " ").trim();

export function forwardSubject(e: ReceivedEmail): string {
  const subject = oneLine(e.subject).slice(0, MAX_SUBJECT_CHARS) || "(no subject)";
  return `${looksSpoofed(e) ? "[spam?] " : ""}[skovern.com] ${subject}`;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function megabytes(bytes: number): string {
  return `${Math.max(0.1, Math.round(bytes / 104857.6) / 10)} MB`;
}

export interface ForwardOptions {
  forwardTo: string;
  /** Attachment ID → signed download link, from the Receiving API. */
  links: Map<string, string>;
  /** False drops every attachment and lists them by name instead. */
  withAttachments: boolean;
}

/** Attach everything, or nothing: when one file can't be attached (no link) or
 *  they're too big together, every file is listed by name instead. */
function pickAttachments(e: ReceivedEmail, o: ForwardOptions): ResendAttachment[] | null {
  if (!o.withAttachments || e.attachments.length === 0) return null;
  const total = e.attachments.reduce((sum, a) => sum + a.size, 0);
  if (total > MAX_ATTACHMENT_BYTES) return null;
  const out: ResendAttachment[] = [];
  for (const a of e.attachments) {
    const path = o.links.get(a.id);
    if (!path) return null;
    out.push({
      filename: oneLine(a.filename) || "attachment",
      path,
      ...(a.contentType ? { content_type: a.contentType } : {}),
      ...(a.contentId ? { content_id: a.contentId.replace(/^<|>$/g, "") } : {}),
    });
  }
  return out;
}

export function buildForward(e: ReceivedEmail, o: ForwardOptions): ResendEmail {
  const attachments = pickAttachments(e, o);
  const header = [
    `From: ${oneLine(e.from)}`,
    `To: ${e.to.map(oneLine).join(", ")}`,
    ...(e.cc.length ? [`Cc: ${e.cc.map(oneLine).join(", ")}`] : []),
  ];
  const notes: string[] = [];
  if (e.attachments.length && !attachments) {
    notes.push(
      "Attachments not forwarded. Open this email in Resend (Receiving) to get them:",
      ...e.attachments.map((a) => `- ${oneLine(a.filename) || "attachment"} (${megabytes(a.size)})`),
    );
  }
  const html = e.html !== null && e.html.length <= MAX_HTML_CHARS ? e.html : null;
  if (e.html !== null && html === null) notes.push("The formatted version was too big to forward; this is the plain text.");
  const footer = notes.length ? `\n\n--\n${notes.join("\n")}` : "";
  const body = e.text?.slice(0, MAX_TEXT_CHARS) ?? (html ? "(This email has only a formatted version.)" : "(This email is empty.)");
  const reply = replyAddress(e);
  const banner = (lines: string[]): string =>
    `<div style="font:13px sans-serif;color:#555;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:12px">` +
    `${lines.map(escapeHtml).join("<br>")}</div>`;
  return {
    from: INBOX_FROM,
    to: o.forwardTo,
    subject: forwardSubject(e),
    text: `${header.join("\n")}\n\n${body}${footer}`,
    ...(html !== null ? { html: `${banner(header)}${html}${notes.length ? banner(notes) : ""}` } : {}),
    ...(reply ? { reply_to: reply } : {}),
    ...(attachments ? { attachments } : {}),
    tags: [{ name: "kind", value: FORWARD_TAG }],
  };
}
