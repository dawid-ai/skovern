import { MailError, resendPost, type ResendEmail } from "../auth/mailer.js";
import { isOwnDomain } from "../server/config.js";
import type { ResendQuota } from "../server/resend-usage.js";
import { AUTO_SUBMITTED, autoKind, buildForward, FORWARD_TAG, looksSpoofed, senderAddress } from "./message.js";
import { getAttachmentLinks, getReceivedEmail, type ReceivedEmail, type ResendApi } from "./resend-api.js";
import type { InboxStore, Lease } from "./store.js";

// Forwards one pending email (the worker calls this): fetch it by ID, refuse
// loops, take a slot under the forward cap and the shared Resend quota, send it
// to FORWARD_TO. Sends carry an Idempotency-Key, so a retry after a lost answer
// doesn't deliver twice. Any failure that may pass leaves the email pending for
// the next try; nothing is dropped without a log line.

export interface ForwardDeps {
  api: ResendApi;
  /** The From line of forwards and the alert (message.ts inboxFrom). */
  from: string;
  store: InboxStore;
  forwardTo: string;
  maxPerDay: number;
  /** Forwards of possibly spoofed mail a day, on their own cap (FLAGGED_MAX_PER_DAY). */
  flaggedPerDay: number;
  /** INBOX_AUTH_MISSING_OK: no authentication results isn't a flag. */
  authMissingOk?: boolean;
  quota: ResendQuota;
}

export type ForwardOutcome = "forwarded" | "held" | "loop" | "refused" | "gone" | "retry";

type Sent = "sent" | "refused" | "retry";

/** An authentication result as it may appear in a log: a short lowercase word
 *  (pass, fail, gray, ...), or `other`. The value comes from mail we don't
 *  control, so nothing else reaches the logs. */
export function authWord(v: string | null): string {
  return v !== null && /^[a-z]{1,16}$/.test(v) ? v : "other";
}

const permanent = (err: unknown): boolean =>
  err instanceof MailError && (err.status === 400 || err.status === 404 || err.status === 422);
const why = (err: unknown): string =>
  err instanceof MailError ? `status ${err.status ?? "unreachable"}${err.code ? ` ${err.code}` : ""}` : (err as Error).message;

async function send(deps: ForwardDeps, emailId: string, mail: ResendEmail, key: string): Promise<Sent> {
  try {
    await resendPost(deps.api.baseUrl, deps.api.apiKey, mail, { idempotencyKey: key });
    return "sent";
  } catch (err) {
    // The key went out with an earlier attempt whose answer we lost. The body
    // differs only by freshly signed attachment links, so it was delivered.
    if (err instanceof MailError && err.status === 409 && err.code === "invalid_idempotent_request") {
      console.warn(
        `[inbox] Resend reports ${key} as already used, so the forward of email ${emailId} is assumed delivered. ` +
          "If it didn't arrive, read it in Resend's Receiving tab.",
      );
      return "sent";
    }
    console.error(`[inbox] sending the forward of email ${emailId} failed (${why(err)})`);
    return permanent(err) ? "refused" : "retry";
  }
}

async function retry(deps: ForwardDeps, job: Lease): Promise<"retry"> {
  await deps.store.retryLater(job.emailId, job.attempts);
  return "retry";
}

async function hold(deps: ForwardDeps, emailId: string): Promise<"held"> {
  await deps.store.settle(emailId, "held");
  console.warn(`[inbox] forward budget spent; email ${emailId} is waiting in Resend`);
  await sendPausedAlert(deps);
  return "held";
}

export async function processOne(deps: ForwardDeps, job: Lease): Promise<ForwardOutcome> {
  const { emailId } = job;
  // Second lock on the door: config already refuses a FORWARD_TO at our domain.
  if (isOwnDomain(deps.forwardTo)) {
    await deps.store.settle(emailId, "skipped");
    return "loop";
  }
  let email: ReceivedEmail;
  try {
    email = await getReceivedEmail(deps.api, emailId);
  } catch (err) {
    console.error(`[inbox] fetching received email ${emailId} failed (${why(err)})`);
    if (!permanent(err)) return retry(deps, job);
    await deps.store.settle(emailId, "gone");
    return "gone";
  }
  const sender = senderAddress(email.from);
  if (sender && isOwnDomain(sender)) {
    await deps.store.settle(emailId, "skipped");
    return "loop";
  }
  // Neither automatic nor possibly spoofed mail takes a main forward slot, so a
  // burst of either can't use up the day's forwards. Both count as received.
  const auto = autoKind(email);
  if (auto === "replied") {
    await deps.store.settle(emailId, "held_auto");
    console.warn(`[inbox] email ${emailId} is an automatic reply; it stays in Resend`);
    return "held";
  }
  // Possibly spoofed mail is still forwarded, flagged [spam?] (a small shop's
  // weak SPF shouldn't lose its mail), but on its own small cap. Past that cap,
  // it stays in Resend.
  if (email.authentication === null) {
    const then = deps.authMissingOk ? "forwarding it unflagged (INBOX_AUTH_MISSING_OK=1)" : "treating it as flagged";
    console.warn(`[inbox] no authentication data on ${emailId}; ${then}`);
  }
  const spoofed = looksSpoofed(email, deps.authMissingOk);
  if (spoofed || auto === "other") {
    const slot = await deps.store.claimSlot(`forward/${emailId}`, "flagged", deps.quota, deps.flaggedPerDay);
    if (slot !== "ok") {
      await deps.store.settle(emailId, spoofed ? "held_spam" : "held_auto");
      const a = email.authentication;
      const checks = a ? `spf ${authWord(a.spf)}, dkim ${authWord(a.dkim)}, dmarc ${authWord(a.dmarc)}` : "no checks";
      const what = spoofed ? `may be spoofed (${checks})` : "is automatic mail";
      const reason = slot === "cap" ? "the flagged cap is used" : "the shared Resend budget is spent";
      console.warn(`[inbox] email ${emailId} ${what} and ${reason}; it stays in Resend`);
      if (slot === "quota") await sendPausedAlert(deps);
      return "held";
    }
  } else if ((await deps.store.claimSlot(`forward/${emailId}`, "forward", deps.quota, deps.maxPerDay)) !== "ok") {
    return hold(deps, emailId);
  }

  let links = new Map<string, string>();
  if (email.attachments.length && !job.namesOnly) {
    try {
      links = await getAttachmentLinks(deps.api, emailId);
    } catch (err) {
      console.error(`[inbox] fetching attachment links of email ${emailId} failed (${why(err)})`);
      if (!permanent(err)) return retry(deps, job);
    }
  }
  const build = (withAttachments: boolean): ResendEmail =>
    buildForward(email, { from: deps.from, forwardTo: deps.forwardTo, links, withAttachments, authMissingOk: deps.authMissingOk ?? false });

  let result: Sent = "refused";
  if (!job.namesOnly) {
    result = await send(deps, emailId, build(true), `forward/${emailId}`);
    if (result === "retry") return retry(deps, job);
    if (result === "refused" && email.attachments.length) await deps.store.markNamesOnly(emailId);
  }
  // A refused attachment (too big, a link Resend can't fetch) shouldn't lose the
  // message: send it again with the files listed by name. That's one more send.
  if (result === "refused" && email.attachments.length) {
    if ((await deps.store.claimSlot(`forward/${emailId}/names`, "names", deps.quota)) !== "ok") return hold(deps, emailId);
    result = await send(deps, emailId, build(false), `forward/${emailId}/names`);
    if (result === "retry") return retry(deps, job);
  }
  await deps.store.settle(emailId, result === "sent" ? "forwarded" : "refused");
  return result === "sent" ? "forwarded" : "refused";
}

export const PAUSED_ALERT = {
  subject: "[skovern.com] Forwarding paused for today",
  text:
    "Forwarding paused for today. New mail is waiting in Resend → Emails → Receiving.\n\n" +
    "Forwarding starts again after midnight UTC. Mail that arrives before then stays in Resend " +
    "and isn't forwarded later, so read it there.\n",
};

/** The UTC day whose skipped alert was already logged (one line a day). */
let skipLoggedFor = "";
/** Test seam: let the next skipped-alert line through. */
export function resetAlertSkipLog(): void {
  skipLoggedFor = "";
}

/** Send today's one "forwarding paused" alert, if it hasn't gone out. It counts
 *  against the quota and may use the reserve; with the whole quota spent it's
 *  skipped, with one log line so the stop isn't silent. Never throws. */
async function sendPausedAlert(deps: ForwardDeps): Promise<void> {
  let day: string | null = null;
  try {
    const claim = await deps.store.claimSummary(deps.quota);
    if (claim.status === "full" && skipLoggedFor !== claim.day) {
      skipLoggedFor = claim.day;
      console.warn(`[inbox] forwarding paused, but the alert was skipped: Resend's daily quota is full (${claim.day} UTC)`);
    }
    if (claim.status !== "claimed") return;
    day = claim.day;
    await resendPost(
      deps.api.baseUrl,
      deps.api.apiKey,
      { from: deps.from, to: deps.forwardTo, ...PAUSED_ALERT, headers: { ...AUTO_SUBMITTED }, tags: [{ name: "kind", value: FORWARD_TAG }] },
      { idempotencyKey: `summary/${day}` },
    );
  } catch (err) {
    console.error(`[inbox] sending the forwarding-paused alert failed (${why(err)})`);
    const resent = err instanceof MailError && err.status === 409 && err.code === "invalid_idempotent_request";
    if (day !== null && !permanent(err) && !resent) await deps.store.releaseSummary(day).catch(() => {});
  }
}
