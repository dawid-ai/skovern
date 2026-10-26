import { randomBytes } from "node:crypto";
import type { HttpResult } from "../auth/handlers.js";
import { requireAdmin } from "../auth/admin.js";
import { escapeHtml } from "../html.js";
import type { WaitlistEntry, WaitlistStore } from "./store.js";
import { BUSINESS_TYPES } from "./validate.js";

// Founder view of the waitlist: counts by business type, the full list, and a
// CSV export. Basic-auth guarded by the same admin token as /admin/dm.

const LABELS: Record<string, string> = {
  florist: "Florist",
  cafe: "Bakery or café",
  salon: "Salon or barber",
  restaurant: "Restaurant",
  retail: "Retail shop",
  trades: "Trades",
  fitness: "Fitness studio",
  wellness: "Health and wellness",
  services: "Professional services",
  other: "Other",
};

/** One CSV cell. Quotes always; a leading = + - @ (or tab/CR) gets a `'` so a
 *  spreadsheet shows the text instead of running it as a formula. */
export function csvCell(value: string | number | null): string {
  let s = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(rows: WaitlistEntry[]): string {
  const head = ["number", "name", "email", "job_title", "business_type", "website", "joined_at"];
  const lines = rows.map((r) =>
    [r.number, r.name, r.email, r.jobTitle, r.businessType, r.url, r.createdAt].map(csvCell).join(","),
  );
  return [head.map(csvCell).join(","), ...lines].join("\r\n") + "\r\n";
}

export async function handleAdminWaitlistCsv(
  store: WaitlistStore,
  adminToken: string | null,
  authHeader: string | null,
): Promise<HttpResult> {
  const denied = requireAdmin(adminToken, authHeader);
  if (denied) return denied;
  const date = new Date().toISOString().slice(0, 10);
  return {
    status: 200,
    body: toCsv(await store.list()),
    contentType: "text/csv; charset=utf-8",
    headers: {
      "content-disposition": `attachment; filename="skovern-waitlist-${date}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  };
}

export async function handleAdminWaitlist(
  store: WaitlistStore,
  adminToken: string | null,
  authHeader: string | null,
): Promise<HttpResult> {
  const denied = requireAdmin(adminToken, authHeader);
  if (denied) return denied;
  const rows = await store.list();
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = r.businessType ?? "unanswered";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const countRows = [...BUSINESS_TYPES, "unanswered"]
    .filter((k) => counts.has(k))
    .map((k) => `<tr><td>${escapeHtml(LABELS[k] ?? "Didn't say")}</td><td>${counts.get(k)}</td></tr>`)
    .join("");
  const listRows = rows
    .map(
      (r) =>
        `<tr><td>#${r.number}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.email)}</td>` +
        `<td>${escapeHtml(r.jobTitle ?? "")}</td><td>${escapeHtml(r.businessType ? (LABELS[r.businessType] ?? r.businessType) : "")}</td>` +
        `<td>${escapeHtml(r.url ?? "")}</td><td>${escapeHtml(r.createdAt.slice(0, 16).replace("T", " "))}</td></tr>`,
    )
    .join("");
  const nonce = randomBytes(16).toString("base64");
  const html =
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex">` +
    `<title>Waitlist · Skovern admin</title>` +
    `<style nonce="${nonce}">body{font:15px/1.45 system-ui,sans-serif;margin:24px;color:#1d1d1f}` +
    `table{border-collapse:collapse;margin:12px 0 28px}td,th{border-bottom:1px solid #ddd;padding:6px 12px;text-align:left}` +
    `th{font-weight:600}h1{margin:0 0 4px}a{color:#c85f17}</style>` +
    `<h1>Waitlist (${rows.length})</h1><p><a href="/admin/waitlist.csv">Download CSV</a></p>` +
    `<h2>By business type</h2><table><tr><th>Type</th><th>People</th></tr>${countRows || "<tr><td colspan=2>Nobody yet.</td></tr>"}</table>` +
    `<h2>Everyone</h2><table><tr><th>#</th><th>Name</th><th>Email</th><th>Job</th><th>Type</th><th>Website</th><th>Joined (UTC)</th></tr>` +
    `${listRows || "<tr><td colspan=7>Nobody yet.</td></tr>"}</table></html>`;
  return {
    status: 200,
    body: html,
    contentType: "text/html; charset=utf-8",
    headers: {
      "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  };
}
