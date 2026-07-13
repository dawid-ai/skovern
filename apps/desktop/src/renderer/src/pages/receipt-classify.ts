import type { ReceiptView } from "../../../shared/receipts.js";

// How the Receipts panel classifies each log line. Pure + typed so it's unit-testable
// on its own — the page is just the rendering. The key rule (loop 022): whether a call
// is "routine background noise" comes from an AUTHORITATIVE `routine` flag stamped where
// the call is made, NOT from sniffing the task string. So a real message the user sent
// can never be mistaken for a poll, and a poll is grouped even if its label changes.

export type FetchView = Extract<ReceiptView, { kind: "fetch" }>;

export function isFetch(r: ReceiptView): r is FetchView {
  return "kind" in r && r.kind === "fetch";
}

// A local (on-machine) model call — nothing left the machine.
export function isLocal(r: ReceiptView): boolean {
  return !isFetch(r) && r.local === true;
}

// The app's own repeating background checks (news/messages/model-list polls). Grouped
// into one quiet line each instead of a row per poll. Authoritative: driven by the
// write-time `routine` flag, so classification no longer depends on the task wording.
export function isRoutine(r: ReceiptView): boolean {
  return isFetch(r) && r.routine === true;
}

// Nice florist labels for the known routine polls; anything else falls back to its
// own task text so a new routine kind still groups (just with a plainer label).
const ROUTINE_LABELS: Record<string, string> = {
  news: "Checked the news",
  messages: "Checked your messages",
  "model list": "Checked the model list",
};

// The grouping key + display label for a routine receipt. Group by the task so the
// three poll kinds stay separate lines.
export function routineGroup(r: FetchView): { key: string; label: string } {
  const suffix = r.task.startsWith("Deskhand:") ? r.task.slice("Deskhand:".length).trim() : r.task;
  return { key: suffix, label: ROUTINE_LABELS[suffix] ?? `Checked: ${suffix}` };
}
