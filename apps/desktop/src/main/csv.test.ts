import { describe, expect, it } from "vitest";
import type { FetchReceipt, Receipt } from "@skovern/core";
import { toCsv } from "./csv.js";

describe("toCsv", () => {
  it("writes a header + every captured field, model and fetch shapes side by side", () => {
    const model: Receipt = {
      ts: "2026-07-14T10:00:00Z",
      provider: "local",
      model: "qwen",
      task: "Test my brain",
      bytesSent: 5,
      bytesReceived: 9,
      ok: true,
      phase: "done",
      local: true,
      tokensIn: 12,
      tokensOut: 34,
    };
    const fetch: FetchReceipt = {
      kind: "fetch",
      ts: "2026-07-14T11:00:00Z",
      host: "api.skovern.test",
      task: "Skovern: news",
      bytesSent: 20,
      bytesReceived: 100,
      ok: true,
      phase: "done",
      direction: "in",
      routine: true,
    };
    const csv = toCsv([model, fetch]);
    const [header, ...rows] = csv.trimEnd().split("\r\n");
    expect(header).toBe("ts,kind,provider,model,host,task,direction,routine,local,bytesSent,bytesReceived,tokensIn,tokensOut,ok,phase");
    // model row: no kind/host/direction/routine, has provider/model/local/tokens
    expect(rows[0]).toBe("2026-07-14T10:00:00Z,,local,qwen,,Test my brain,,,true,5,9,12,34,true,done");
    // fetch row: kind/host/direction/routine present, provider/model/tokens empty
    expect(rows[1]).toBe("2026-07-14T11:00:00Z,fetch,,,api.skovern.test,Skovern: news,in,true,,20,100,,,true,done");
  });

  it("RFC-4180 quotes a cell with a comma, quote, or newline", () => {
    const r: FetchReceipt = { kind: "fetch", ts: "2026-07-14T10:00:00Z", host: "h", task: 'a, b "c"\nd', bytesSent: 0, bytesReceived: 0, ok: true, phase: "done" };
    const line = toCsv([r]).trimEnd().split("\r\n")[1]!;
    expect(line).toContain('"a, b ""c""\nd"'); // wrapped, inner quotes doubled, comma/newline safe
  });

  // Security-critical: a cell whose value starts with a formula trigger must be
  // neutralized so opening the CSV in Excel/Sheets can't execute it.
  it("neutralizes a formula-injection payload in a semi-controlled field", () => {
    const r: FetchReceipt = { kind: "fetch", ts: "2026-07-14T10:00:00Z", host: "h", task: "=cmd|'/c calc'!A1", bytesSent: 0, bytesReceived: 0, ok: true, phase: "done" };
    const line = toCsv([r]).trimEnd().split("\r\n")[1]!;
    // Prefixed with a single quote → a spreadsheet shows it as literal text, never
    // evaluates it. (No CSV quoting: the payload has no comma/quote/newline.)
    expect(line).toContain("'=cmd|'/c calc'!A1");
    expect(line).not.toMatch(/,=cmd/); // the raw, un-neutralized formula never starts a cell
  });

  it("neutralizes the other formula triggers and a leading tab/CR", () => {
    for (const payload of ["+1", "-1", "@SUM(A1)", "\t=1", "\r=1"]) {
      const r: Receipt = { ts: "2026-07-14T10:00:00Z", provider: "openrouter", model: "m", task: payload, bytesSent: 0, bytesReceived: 0, ok: true, phase: "done" };
      const cell = toCsv([r]).trimEnd().split("\r\n")[1]!.split(",")[5]!; // the `task` column (unquoted for +/-/@)
      expect(cell.startsWith("'") || cell.startsWith('"')).toBe(true);
    }
  });

  it("empty list → header only", () => {
    expect(toCsv([]).trimEnd()).toBe("ts,kind,provider,model,host,task,direction,routine,local,bytesSent,bytesReceived,tokensIn,tokensOut,ok,phase");
  });
});
