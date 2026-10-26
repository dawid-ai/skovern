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
 * - "refused": the mail service answered 4xx; this address will never work, so
 *   the row is marked skipped and the budget slot handed back.
 * - "failed": 5xx or unreachable; the claim goes back so the backlog retries.
 * Never throws; never logs the address.
 */
export type Delivery = "sent" | "refused" | "failed";

export async function deliverWelcome(deps: WelcomeDeps, job: WelcomeJob): Promise<Delivery> {
  try {
    const removeToken = await deps.store.issueToken(job.id, "remove");
    const removeUrl = `${deps.appUrl()}/waitlist/remove?t=${removeToken}`;
    await deps.mailer.sendWelcome(job.email, { name: job.name, number: job.number, removeUrl });
    return "sent";
  } catch (err) {
    const status = err instanceof MailError ? err.status : null;
    const refused = status !== null && status >= 400 && status < 500;
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
