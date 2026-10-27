import { MailError, resendPost } from "../auth/mailer.js";
import { isOwnDomain } from "../server/config.js";
import { buildForward, FORWARD_TAG, INBOX_FROM, senderAddress } from "./message.js";
import { getAttachmentLinks, getReceivedEmail, type ReceivedEmail, type ResendApi } from "./resend-api.js";
import type { InboxStore } from "./store.js";

// Forwards one received email: fetch it by ID, refuse loops, take a budget
// slot, send it to FORWARD_TO. Over the budget the email stays in Resend, and
// the first held email of the (UTC) day sends one "emails waiting" summary.

export interface ForwardDeps {
  api: ResendApi;
  store: InboxStore;
  forwardTo: string;
  maxPerDay: number;
}

/**
 * - forwarded: sent to FORWARD_TO.
 * - held: over the day's budget; left in Resend.
 * - duplicate: this email was already handled.
 * - loop: from our own domain (or FORWARD_TO is ours); never forwarded.
 * - refused: Resend won't take it (400 or 422), even without attachments.
 * - gone: Resend has no such email.
 * Any other failure throws a MailError, after giving back what it took, so the
 * webhook answers 500 and Svix retries.
 */
export type ForwardOutcome = "forwarded" | "held" | "duplicate" | "loop" | "refused" | "gone";

const permanent = (err: unknown): boolean =>
  err instanceof MailError && (err.status === 400 || err.status === 404 || err.status === 422);

export async function forwardReceived(deps: ForwardDeps, emailId: string): Promise<ForwardOutcome> {
  // Second lock on the door: config already refuses a FORWARD_TO at our domain.
  if (isOwnDomain(deps.forwardTo)) return "loop";
  let email: ReceivedEmail;
  try {
    email = await getReceivedEmail(deps.api, emailId);
  } catch (err) {
    if (permanent(err)) return "gone";
    throw err;
  }
  const sender = senderAddress(email.from);
  if (sender && isOwnDomain(sender)) {
    return (await deps.store.skip(emailId)) ? "loop" : "duplicate";
  }

  const claim = await deps.store.claim(emailId, deps.maxPerDay);
  if (claim === "duplicate") return "duplicate";
  if (claim === "hold") {
    console.warn(`[inbox] forward budget spent (${deps.maxPerDay} a day); email ${emailId} is waiting in Resend`);
    await sendHeldSummary(deps);
    return "held";
  }

  try {
    const links = email.attachments.length ? await getAttachmentLinks(deps.api, emailId) : new Map<string, string>();
    const send = (withAttachments: boolean): Promise<void> =>
      resendPost(deps.api.baseUrl, deps.api.apiKey, buildForward(email, { forwardTo: deps.forwardTo, links, withAttachments }));
    try {
      await send(true);
    } catch (err) {
      // A refused attachment (too big, a link Resend can't fetch) shouldn't
      // lose the message: send it once more with the files listed by name.
      if (!permanent(err) || email.attachments.length === 0) throw err;
      await send(false);
    }
    return "forwarded";
  } catch (err) {
    if (permanent(err)) {
      console.error(`[inbox] Resend refused the forward of email ${emailId}:`, (err as Error).message);
      await deps.store.refused(emailId);
      return "refused";
    }
    await deps.store.release(emailId);
    throw err;
  }
}

export function summaryText(waiting: number, perDay: number): { subject: string; text: string } {
  const n = `${waiting} email${waiting === 1 ? "" : "s"}`;
  return {
    subject: `[skovern.com] ${n} waiting in Resend`,
    text:
      `${n} waiting in Resend.\n\n` +
      `Today's forward limit (${perDay} a day) is used up, so new mail to @skovern.com ` +
      `stays in Resend instead of coming here. Read it in the Resend dashboard, under Emails, Receiving.\n\n` +
      `Forwarding picks up again as the last 24 hours' count drops. This is the only summary today.\n`,
  };
}

/** Send today's one summary, if it hasn't gone out. Never throws. */
async function sendHeldSummary(deps: ForwardDeps): Promise<void> {
  try {
    const waiting = await deps.store.claimSummary();
    if (waiting === null) return;
    try {
      await resendPost(deps.api.baseUrl, deps.api.apiKey, {
        from: INBOX_FROM,
        to: deps.forwardTo,
        ...summaryText(Math.max(1, waiting), deps.maxPerDay),
        tags: [{ name: "kind", value: FORWARD_TAG }],
      });
    } catch (err) {
      console.error("[inbox] the waiting-mail summary failed:", (err as Error).message);
      if (!permanent(err)) await deps.store.releaseSummary();
    }
  } catch (err) {
    console.error("[inbox] couldn't record the waiting-mail summary:", (err as Error).message);
  }
}
