import { describe, expect, it } from "vitest";
import type { FetchReceipt, Receipt } from "../../../shared/receipts.js";
import { direction, isLocal, isRoutine, routineGroup } from "./receipt-classify.js";

// Loop 022: routine-vs-meaningful is decided by the write-time `routine` flag, NOT by
// sniffing the task string. These pin that so a real user message can't be hidden as
// a poll, and a poll groups even if its label changes.

function fetchReceipt(over: Partial<FetchReceipt>): FetchReceipt {
  return { kind: "fetch", ts: "2026-07-13T00:00:00Z", host: "api.test", task: "x", bytesSent: 1, bytesReceived: 1, ok: true, phase: "done", ...over };
}

function modelReceipt(over: Partial<Receipt>): Receipt {
  return { ts: "2026-07-13T00:00:00Z", provider: "local", model: "m", task: "t", bytesSent: 1, bytesReceived: 1, ok: true, phase: "done", ...over };
}

describe("isRoutine — authoritative, not string-sniffed", () => {
  it("is true only for a fetch explicitly marked routine", () => {
    expect(isRoutine(fetchReceipt({ routine: true }))).toBe(true);
    expect(isRoutine(fetchReceipt({ routine: false }))).toBe(false);
    expect(isRoutine(fetchReceipt({}))).toBe(false); // absent → not routine
  });

  it("a routine-marked call groups regardless of its task wording", () => {
    expect(isRoutine(fetchReceipt({ routine: true, task: "skill:weird fetch" }))).toBe(true);
  });

  it("a call NOT marked routine is never routine, even if its task LOOKS like a poll", () => {
    // This is the exact bug the old sniff had: a user's message shares the "messages"
    // label but is real egress — it must NOT be grouped away.
    expect(isRoutine(fetchReceipt({ routine: undefined, task: "Skovern: messages" }))).toBe(false);
    expect(isRoutine(fetchReceipt({ task: "Skovern: news" }))).toBe(false);
  });

  it("a model (brain) receipt is never routine", () => {
    expect(isRoutine(modelReceipt({ local: true }))).toBe(false);
    expect(isRoutine(modelReceipt({ provider: "openrouter" }))).toBe(false);
  });
});

describe("routineGroup — florist labels, task as key", () => {
  it("labels the known polls and keys by task suffix", () => {
    expect(routineGroup(fetchReceipt({ task: "Skovern: news" }))).toEqual({ key: "news", label: "Checked the news" });
    expect(routineGroup(fetchReceipt({ task: "Skovern: messages" })).label).toBe("Checked your messages");
    expect(routineGroup(fetchReceipt({ task: "Skovern: model list" })).label).toBe("Checked the model list");
    expect(routineGroup(fetchReceipt({ task: "Skovern: update check" })).label).toBe("Checked for a Skovern update");
  });

  it("falls back to a plain label for an unknown routine kind", () => {
    expect(routineGroup(fetchReceipt({ task: "Skovern: weather" }))).toEqual({ key: "weather", label: "Checked: weather" });
  });
});

describe("direction — In/Out from the authoritative field", () => {
  it("reads a fetch receipt's stamped direction", () => {
    expect(direction(fetchReceipt({ direction: "out" }))).toBe("out");
    expect(direction(fetchReceipt({ direction: "in" }))).toBe("in");
    expect(direction(fetchReceipt({}))).toBeNull(); // unstamped → no arrow
  });

  it("a cloud brain call is Out (your prompt leaves); a local one has no direction", () => {
    expect(direction(modelReceipt({ provider: "openrouter" }))).toBe("out");
    expect(direction(modelReceipt({ provider: "local", local: true }))).toBeNull();
  });
});

describe("isLocal", () => {
  it("is true only for an on-machine model receipt", () => {
    expect(isLocal(modelReceipt({ local: true }))).toBe(true);
    expect(isLocal(modelReceipt({ local: undefined }))).toBe(false);
    expect(isLocal(fetchReceipt({ routine: true }))).toBe(false);
  });
});
