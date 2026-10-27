import { MailError } from "../auth/mailer.js";
import type { WelcomeMailer } from "./mail.js";
import type { WaitlistStore, WelcomeJob } from "./store.js";

// Sends one claimed welcome email: mint a remove link, send, and settle the
// claim by how it went. Shared by the signup handler and the backlog sender in
// server/sweep.ts.

export interface WelcomeDeps {
  store: WaitlistStore;
  mailer: WelcomeMailer;
  /** Public base of this API, for the remove link. */
  appUrl: () => string;
}

/**
 * - "sent": it went out.
 * - "refused": the mail service answered 400 or 422 (bad address or message),
 *   so the row is marked skipped and the budget slot handed back.
 * - "failed": anything else (401, 403, 429, 5xx, unreachable); the claim goes
 *   back so the backlog retries, and the backlog stops this run.
 * Never throws; never logs the address.
 */
export type Delivery = "sent" | "refused" | "failed";

export async function deliverWelcome(deps: WelcomeDeps, job: WelcomeJob): Promise<Delivery> {
  try {
    const removeToken = await deps.store.issueToken(job.id, "remove");
    const removeUrl = `${deps.appUrl()}/waitlist/remove?t=${removeToken}`;
    const resendId = await deps.mailer.sendWelcome(job.email, { name: job.name, number: job.number, removeUrl });
    // Bounce events name the email by this ID (bounce-pause.ts). A failure to
    // record it must not turn a sent welcome into a retried one.
    if (resendId) await deps.store.recordWelcomeId(job.claim, resendId).catch(() => {});
    return "sent";
  } catch (err) {
    const status = err instanceof MailError ? err.status : null;
    // Only "this message/address is bad" is about the person. 401/403 (our key
    // or domain), 429 (rate or quota), 5xx, and no answer are about us or the
    // mail service: hand the claim back and let the caller stop.
    const refused = status === 400 || status === 422;
    console.error(`[waitlist] welcome email ${refused ? "refused" : "failed"}:`, (err as Error).message);
    try {
      if (refused) await deps.store.skipWelcome(job.id, job.claim);
      else await deps.store.releaseWelcome(job.id, job.claim);
    } catch (settleErr) {
      console.error("[waitlist] couldn't settle the welcome claim:", (settleErr as Error).message);
    }
    return refused ? "refused" : "failed";
  }
}
