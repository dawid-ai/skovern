import { normalizeEmail } from "../auth/service.js";

// Pure input rules for the waitlist API. Each rejection names the field and a
// florist-plain reason, so the form can show it under the right input.

export const BUSINESS_TYPES = [
  "florist",
  "cafe",
  "salon",
  "restaurant",
  "retail",
  "trades",
  "fitness",
  "wellness",
  "services",
  "other",
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const MAX_NAME = 80;
export const MAX_JOB = 80;
export const MAX_URL = 200;

/** Letters (any language), combining marks, the zero-width non-joiner (Persian
 *  names), spaces, apostrophes, periods, hyphens. At least one letter. */
const NAME = /^[\p{L}\p{M}\u200C'\u2019 .-]{1,80}$/u;
const HAS_LETTER = /\p{L}/u;
/** Two or more letters, a period, two or more letters: "refund.icu", "evil .com",
 *  "Refund.ICU". Initials don't match ("J.Smith", "A.J. Okafor", "St. Clair"). */
const WORD_DOT_WORD = /\p{L}{2,}\s*\.\p{L}{2,}/iu;

/** True when a name reads like a web address. A one-letter host ("x.bond") gets
 *  through, because refusing it would refuse "mary j.blige" too; the welcome
 *  email drops any word with a period (greetingName), so it never reaches a mailbox. */
export function looksLikeDomain(name: string): boolean {
  return WORD_DOT_WORD.test(name);
}

export interface FieldError {
  field: string;
  message: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: FieldError };

function str(body: unknown, key: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
}

const fail = (field: string, message: string): { ok: false; error: FieldError } => ({
  ok: false,
  error: { field, message },
});

export interface SignupInput {
  name: string;
  email: string;
  /** True when the hidden honeypot field was filled: a bot. */
  bot: boolean;
}

export function checkSignup(body: unknown): Checked<SignupInput> {
  const honeypot = str(body, "company_website");
  const bot = typeof honeypot === "string" && honeypot.trim() !== "";
  const rawName = str(body, "name");
  const name = typeof rawName === "string" ? rawName.trim().replace(/\s+/g, " ") : "";
  if (!name) return fail("name", "Tell us what to call you.");
  if (name.length > MAX_NAME) return fail("name", "That name is a bit long. A first name is plenty.");
  // The name goes into the welcome email ("Hi Rosa,"), so it may hold only
  // letters, spaces, and the marks real names use. That keeps links, markup, and
  // control characters out of a message we send to whatever address was typed.
  if (!NAME.test(name) || !HAS_LETTER.test(name)) return fail("name", "Use just letters in your name, please.");
  if (looksLikeDomain(name)) return fail("name", "That looks like a web address. Just your name, please.");
  const rawEmail = str(body, "email");
  if (typeof rawEmail !== "string" || !rawEmail.trim()) {
    return fail("email", "We need an email to save your spot.");
  }
  const email = rawEmail.length <= 254 ? normalizeEmail(rawEmail) : null;
  if (!email) return fail("email", "That email looks off. Check for a typo?");
  return { ok: true, value: { name, email, bot } };
}

export interface DetailsInput {
  token: string;
  jobTitle: string | null;
  businessType: BusinessType | null;
  url: string | null;
}

const HOST_PATH = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:\d{1,5})?(\/\S*)?$/i;

/** Loose website rule: scheme optional, http(s) only, host must look real. */
export function checkUrl(raw: string): Checked<string> {
  const value = raw.trim();
  if (value.length > MAX_URL) return fail("url", "That web address is too long.");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") {
    return fail("url", "Use a normal web address, like bloomandvine.shop.");
  }
  const rest = scheme ? value.replace(/^[a-z]+:\/\//i, "") : value;
  if (scheme && rest === value) return fail("url", "That doesn't look like a web address.");
  if (!HOST_PATH.test(rest)) {
    return fail("url", "That doesn't look like a web address. Try something like bloomandvine.shop.");
  }
  return { ok: true, value: `${scheme ?? "https"}://${rest}` };
}

export function checkDetails(body: unknown): Checked<DetailsInput> {
  const token = str(body, "detailsToken");
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    return fail("detailsToken", "This form timed out. Your spot is saved, so you can skip this.");
  }
  const rawJob = str(body, "jobTitle");
  const rawType = str(body, "businessType");
  const rawUrl = str(body, "url");
  for (const [k, v] of [["jobTitle", rawJob], ["businessType", rawType], ["url", rawUrl]] as const) {
    if (v !== undefined && v !== null && typeof v !== "string") return fail(k, "That answer looks off.");
  }
  const job = typeof rawJob === "string" ? rawJob.trim().replace(/\s+/g, " ") : "";
  if (job.length > MAX_JOB) return fail("jobTitle", "Keep it under 80 letters.");
  if (/\p{Cc}/u.test(job)) return fail("jobTitle", "That job title has odd characters in it.");
  const type = typeof rawType === "string" ? rawType.trim() : "";
  if (type && !(BUSINESS_TYPES as readonly string[]).includes(type)) {
    return fail("businessType", "Pick a business type from the list.");
  }
  let url: string | null = null;
  if (typeof rawUrl === "string" && rawUrl.trim()) {
    const checked = checkUrl(rawUrl);
    if (!checked.ok) return checked;
    url = checked.value;
  }
  if (!job && !type && !url) return fail("jobTitle", "Fill in at least one, or tap Skip.");
  return {
    ok: true,
    value: { token, jobTitle: job || null, businessType: (type || null) as BusinessType | null, url },
  };
}
