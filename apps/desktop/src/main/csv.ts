import type { ReceiptView } from "../shared/receipts.js";

// Turn selected receipts into a spreadsheet the florist can keep. Metadata only —
// the same non-secret fields the log holds (no key, header, or body). Two safety
// jobs beyond "join with commas":
//   1. RFC-4180 quoting so a value with a comma/quote/newline can't shift columns.
//   2. Formula-injection neutralizing so opening the file in Excel/Sheets can't
//      execute a cell as a formula (a `task` or `host` is semi-attacker-controlled).

// Every field Deskhand captures, in a fixed column order. A receipt that lacks a field
// (e.g. a fetch has no `provider`) gets an empty cell.
const COLUMNS = [
  "ts",
  "kind",
  "provider",
  "model",
  "host",
  "task",
  "direction",
  "routine",
  "local",
  "bytesSent",
  "bytesReceived",
  "tokensIn",
  "tokensOut",
  "ok",
  "phase",
] as const;

// A leading =, +, -, @ (or a tab/CR that a spreadsheet trims back to one of those)
// makes a cell a formula. Prefix such a value with a single quote so it's shown as
// literal text and never evaluated. Applied to the RAW value, before CSV quoting.
function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

// RFC-4180: wrap in double quotes and double any internal quote when the value holds a
// comma, quote, CR, or LF; otherwise pass through.
function quoteCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// One cell: stringify (empty for absent), neutralize a formula, then CSV-quote.
function cell(value: unknown): string {
  if (value === undefined || value === null) return "";
  return quoteCsv(neutralizeFormula(String(value)));
}

// Read a column off either receipt shape; absent → undefined → empty cell.
function field(r: ReceiptView, key: string): unknown {
  return (r as unknown as Record<string, unknown>)[key];
}

// Serialize receipts to CSV text: a header row + one row per receipt, CRLF line
// endings (RFC-4180). Rows are written in the order given.
export function toCsv(receipts: readonly ReceiptView[]): string {
  const lines = [COLUMNS.join(",")];
  for (const r of receipts) {
    lines.push(COLUMNS.map((c) => cell(field(r, c))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
