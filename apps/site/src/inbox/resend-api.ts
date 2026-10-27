import { errorCode, MailError } from "../auth/mailer.js";

// Reads a received email back from Resend's Receiving API, by the ID in the
// webhook. The webhook body only says WHICH email arrived; everything that is
// forwarded (sender, subject, body, attachments) comes from these calls, made
// with our own API key.
//
//   GET /emails/receiving/{id}?html_format=cid
//   GET /emails/receiving/{id}/attachments

/** Under the Svix delivery timeout, with room for the send that follows. */
const FETCH_TIMEOUT_MS = 4_000;

export interface ResendApi {
  baseUrl: string;
  apiKey: string;
}

export interface ReceivedAttachment {
  id: string;
  filename: string;
  contentType: string | null;
  contentId: string | null;
  size: number;
}

export interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  /** The message's own Reply-To addresses, if any. */
  replyTo: string[];
  subject: string;
  text: string | null;
  html: string | null;
  /** SPF, DKIM, and DMARC results from Resend's receiving server, not from the
   *  message's own headers, so the sender can't forge them. Lowercased; null
   *  when the API reported none (authResults). */
  authentication: { spf: string | null; dkim: string | null; dmarc: string | null } | null;
  attachments: ReceivedAttachment[];
  /** The message's Auto-Submitted header (RFC 3834), if any. */
  autoSubmitted: string | null;
}

/** Resend email IDs are UUIDs; anything else never reaches a URL. */
export const EMAIL_ID = /^[A-Za-z0-9-]{1,100}$/;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function getJson(api: ResendApi, path: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${api.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${api.apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new MailError(null);
  }
  // why: never include the response body; it can carry addresses.
  if (!res.ok) throw new MailError(res.status, await errorCode(res));
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object") return body as Record<string, unknown>;
  } catch {
    // Falls through to the same error as a non-object body.
  }
  throw new MailError(502);
}

/** One header, matched without regard to case. The API's `headers` may be a
 *  map (`{ "Auto-Submitted": "..." }`, a value possibly an array) or a list of
 *  `{ name, value }`; both are read. */
export function headerValue(headers: unknown, name: string): string | null {
  const want = name.toLowerCase();
  const pick = (v: unknown): string | null =>
    typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : null;
  if (Array.isArray(headers)) {
    for (const h of headers as unknown[]) {
      const entry = h && typeof h === "object" ? (h as Record<string, unknown>) : {};
      if (typeof entry["name"] === "string" && entry["name"].toLowerCase() === want) return pick(entry["value"]);
    }
    return null;
  }
  if (!headers || typeof headers !== "object") return null;
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === want) return pick(v);
  }
  return null;
}

/** SPF, DKIM, and DMARC results, lowercased. Null when the API gave none at
 *  all (missing, not an object, or every result empty): that's more likely an
 *  API-shape change than a spoof, so it isn't treated as one. */
export function authResults(raw: unknown): ReceivedEmail["authentication"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const norm = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null);
  const out = { spf: norm(a["spf"]), dkim: norm(a["dkim"]), dmarc: norm(a["dmarc"]) };
  return out.spf || out.dkim || out.dmarc ? out : null;
}

function attachment(raw: unknown): ReceivedAttachment | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const id = str(a["id"]);
  if (!id) return null;
  return {
    id,
    filename: str(a["filename"]) ?? "attachment",
    contentType: str(a["content_type"]),
    contentId: str(a["content_id"]),
    size: typeof a["size"] === "number" && a["size"] >= 0 ? a["size"] : 0,
  };
}

export async function getReceivedEmail(api: ResendApi, id: string): Promise<ReceivedEmail> {
  if (!EMAIL_ID.test(id)) throw new MailError(400);
  const e = await getJson(api, `/emails/receiving/${id}?html_format=cid`);
  return {
    id,
    from: str(e["from"]) ?? "",
    to: strs(e["to"]),
    cc: strs(e["cc"]),
    replyTo: strs(e["reply_to"]),
    subject: str(e["subject"]) ?? "",
    text: str(e["text"]),
    html: str(e["html"]),
    authentication: authResults(e["authentication"]),
    autoSubmitted: headerValue(e["headers"], "auto-submitted"),
    attachments: (Array.isArray(e["attachments"]) ? e["attachments"] : [])
      .map(attachment)
      .filter((x): x is ReceivedAttachment => x !== null),
  };
}

/** Signed download links for the email's attachments, keyed by attachment ID.
 *  Only https links are kept: Resend fetches them when it sends the forward. */
export async function getAttachmentLinks(api: ResendApi, id: string): Promise<Map<string, string>> {
  if (!EMAIL_ID.test(id)) throw new MailError(400);
  const list = await getJson(api, `/emails/receiving/${id}/attachments`);
  const links = new Map<string, string>();
  for (const raw of Array.isArray(list["data"]) ? list["data"] : []) {
    const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const aid = str(a["id"]);
    const url = str(a["download_url"]);
    if (aid && url?.startsWith("https://")) links.set(aid, url);
  }
  return links;
}
