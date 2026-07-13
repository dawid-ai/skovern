import type { Thread } from "@deskhand/core";

// Deciding when a founder reply is genuinely NEW (worth a distinct Receipts entry) vs.
// just the same old/read thread coming back on the next poll. Pure + unit-tested so the
// rule is testable on its own: the main process holds the state, this decides.
//
// Rule (loop 023): count the founder messages in the fetched thread. The FIRST time we
// ever observe a thread, that count is the BASELINE — pre-existing history is not "new".
// After that, any increase means that many new replies arrived → surface them. A count
// that stays the same (or, defensively, drops) is not new. So an old/already-seen message
// re-fetched every 5s never becomes a new entry.

export interface NewnessState {
  /** Founder messages seen so far; `null` until the first observation (baseline). */
  seenFounder: number | null;
}

export const initialNewness: NewnessState = { seenFounder: null };

function founderCount(thread: Thread): number {
  return thread.messages.reduce((n, m) => (m.sender === "founder" ? n + 1 : n), 0);
}

/** Advance the state with a freshly-fetched thread. Returns the new state and how many
 *  genuinely-new founder replies just appeared (0 on the first observation and whenever
 *  nothing new arrived). Never negative. */
export function observeThread(state: NewnessState, thread: Thread): { state: NewnessState; newReplies: number } {
  const count = founderCount(thread);
  // First observation ever → establish the baseline silently; existing history isn't new.
  if (state.seenFounder === null) return { state: { seenFounder: count }, newReplies: 0 };
  const newReplies = Math.max(0, count - state.seenFounder);
  // Keep the high-water mark so a transient count drop (a deleted message) doesn't later
  // re-fire the same replies as "new".
  return { state: { seenFounder: Math.max(state.seenFounder, count) }, newReplies };
}
