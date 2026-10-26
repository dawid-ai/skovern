import type { WelcomeMailer } from "./mail.js";
import type { WaitlistStore, WelcomeJob } from "./store.js";

// Sends one claimed welcome email: mint a remove link, send, and hand the claim
// back if the send fails, so the backlog sender retries it later. Shared by the
// signup handler and the backlog sender in server/sweep.ts.

export interface WelcomeDeps {
  store: WaitlistStore;
  mailer: WelcomeMailer;
  /** Public base of this API, for the remove link. */
  appUrl: () => string;
}

/** True when the email went out. Never throws; never logs the address. */
export async function deliverWelcome(deps: WelcomeDeps, job: WelcomeJob): Promise<boolean> {
  try {
    const removeToken = await deps.store.issueToken(job.id, "remove");
    const removeUrl = `${deps.appUrl()}/waitlist/remove?t=${removeToken}`;
    await deps.mailer.sendWelcome(job.email, { name: job.name, number: job.number, removeUrl });
    return true;
  } catch (err) {
    console.error("[waitlist] welcome email failed:", (err as Error).message);
    try {
      await deps.store.releaseWelcome(job.id, job.claim);
    } catch (releaseErr) {
      console.error("[waitlist] couldn't hand the welcome back:", (releaseErr as Error).message);
    }
    return false;
  }
}
