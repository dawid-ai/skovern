import { afterEach, describe, expect, it, vi } from "vitest";
import { RefusalLog, safeSvixId } from "./refusals.js";

describe("safeSvixId", () => {
  it("keeps only letters, digits, _ and -", () => {
    expect(safeSvixId("msg_2Abc-9")).toBe("msg_2Abc-9");
    expect(safeSvixId("msg\r\n[inbox] forged line")).toBe("msginboxforgedline");
    expect(safeSvixId("x".repeat(100))).toHaveLength(64);
    expect(safeSvixId(undefined)).toBe("none");
    expect(safeSvixId("<>")).toBe("none");
  });
});

describe("RefusalLog", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes one line a minute after the first refusal, with counts, then starts over", () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = new RefusalLog(60_000);
    for (let i = 0; i < 3; i += 1) log.note("bad-signature");
    log.note("stale");
    vi.advanceTimersByTime(59_999);
    expect(warn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(warn.mock.calls.map((c) => c[0])).toEqual(["[inbox] webhook refused 4 times in the last minute (bad-signature 3, stale 1)"]);
    vi.advanceTimersByTime(120_000);
    expect(warn).toHaveBeenCalledTimes(1);
    log.note("missing");
    vi.advanceTimersByTime(60_000);
    expect(warn.mock.calls.at(-1)?.[0]).toBe("[inbox] webhook refused 1 time in the last minute (missing 1)");
  });
});
