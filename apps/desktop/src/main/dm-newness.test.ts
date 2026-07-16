import { describe, expect, it } from "vitest";
import type { Thread } from "@skovern/core";
import { initialNewness, observeThread } from "./dm-newness.js";

// Loop 023: a founder reply is a distinct Receipts entry only when it's genuinely NEW.
// These pin the baseline/dedup rule so old/already-seen messages never re-count as new.

function thread(...senders: ("user" | "founder")[]): Thread {
  return {
    messages: senders.map((sender) => ({ sender, body: "x", createdAt: "2026-07-13T00:00:00Z" })),
    unread: 0,
  };
}

describe("observeThread", () => {
  it("first observation is the baseline — pre-existing history is never 'new'", () => {
    const r = observeThread(initialNewness, thread("user", "founder", "founder"));
    expect(r.newReplies).toBe(0);
    expect(r.state.seenFounder).toBe(2);
  });

  it("re-polling the SAME thread yields no new replies (old/read not re-counted)", () => {
    const t = thread("user", "founder");
    const first = observeThread(initialNewness, t);
    const again = observeThread(first.state, t);
    const third = observeThread(again.state, t);
    expect(again.newReplies).toBe(0);
    expect(third.newReplies).toBe(0);
  });

  it("counts only the founder replies that arrived beyond the baseline", () => {
    const base = observeThread(initialNewness, thread("user", "founder")); // baseline 1
    const grew = observeThread(base.state, thread("user", "founder", "user", "founder", "founder")); // 3 founder
    expect(grew.newReplies).toBe(2);
    expect(grew.state.seenFounder).toBe(3);
  });

  it("a user's own message arriving is not a founder reply", () => {
    const base = observeThread(initialNewness, thread("founder")); // baseline 1
    const grew = observeThread(base.state, thread("founder", "user"));
    expect(grew.newReplies).toBe(0);
  });

  it("an empty thread (e.g. a failed/offline poll) never fabricates a new reply", () => {
    const base = observeThread(initialNewness, thread("founder")); // baseline 1
    const empty = observeThread(base.state, thread()); // no messages came back
    expect(empty.newReplies).toBe(0);
    expect(empty.state.seenFounder).toBe(1); // baseline preserved, not reset
  });

  it("a transient count drop (deleted message) doesn't later re-fire the same replies", () => {
    const base = observeThread(initialNewness, thread("founder", "founder")); // baseline 2
    const dropped = observeThread(base.state, thread("founder")); // 1 now
    expect(dropped.newReplies).toBe(0);
    expect(dropped.state.seenFounder).toBe(2); // high-water kept
    const backTo2 = observeThread(dropped.state, thread("founder", "founder"));
    expect(backTo2.newReplies).toBe(0); // not re-fired
  });
});
