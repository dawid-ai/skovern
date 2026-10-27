import { MailError, resendPost, type ResendEmail } from "../auth/mailer.js";
import { isOwnDomain } from "../server/config.js";
import type { ResendQuota } from "../server/resend-usage.js";
import { buildForward, FORWARD_TAG, INBOX_FROM, senderAddress } from "./message.js";
import { getAttachmentLinks, getReceivedEmail, type ReceivedEmail, type ResendApi } from "./resend-api.js";
import type { InboxStore, Lease } from "./store.js";

// Forwards one pending email (the worker calls this): fetch it by ID, refuse
// loops, take a slot under the forward cap and the shared Resend quota, send it
// to FORWARD_TO. Sends carry an Idempotency-Key, so a retry after a lost answer
// doesn't deliver twice. Any failure that may pass leaves the email pending for
// the next try; nothing is dropped without a log line.

export interface ForwardDeps {
  api: ResendApi;
  store: InboxStore;
  forwardTo: string;
  maxPerDay: number;
  quota: ResendQuota;
}

export type ForwardOutcome = "forwarded" | "held" | "loop" | "refused" | "gone" | "retry";

type Sent = "sent" | "refused" | "retry";

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
      console.warn(`[inbox] forward of email ${emailId} was already sent under ${key}`);
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
  if (!(await deps.store.claimSlot(`forward/${emailId}`, "forward", deps.quota, deps.maxPerDay))) return hold(deps, emailId);

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
    buildForward(email, { forwardTo: deps.forwardTo, links, withAttachments });

  let result: Sent = "refused";
  if (!job.namesOnly) {
    result = await send(deps, emailId, build(true), `forward/${emailId}`);
    if (result === "retry") return retry(deps, job);
    if (result === "refused" && email.attachments.length) await deps.store.markNamesOnly(emailId);
  }
  // A refused attachment (too big, a link Resend can't fetch) shouldn't lose the
  // message: send it again with the files listed by name. That's one more send.
  if (result === "refused" && email.attachments.length) {
    if (!(await deps.store.claimSlot(`forward/${emailId}/names`, "names", deps.quota))) return hold(deps, emailId);
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

/** Send today's one "forwarding paused" alert, if it hasn't gone out. It counts
 *  against the quota and may use the reserve. Never throws. */
async function sendPausedAlert(deps: ForwardDeps): Promise<void> {
  let day: string | null = null;
  try {
    day = await deps.store.claimSummary(deps.quota);
    if (day === null) return;
    await resendPost(
      deps.api.baseUrl,
      deps.api.apiKey,
      { from: INBOX_FROM, to: deps.forwardTo, ...PAUSED_ALERT, tags: [{ name: "kind", value: FORWARD_TAG }] },
      { idempotencyKey: `summary/${day}` },
    );
  } catch (err) {
    console.error(`[inbox] sending the forwarding-paused alert failed (${why(err)})`);
    const resent = err instanceof MailError && err.status === 409 && err.code === "invalid_idempotent_request";
    if (day !== null && !permanent(err) && !resent) await deps.store.releaseSummary(day).catch(() => {});
  }
}
