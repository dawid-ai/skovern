// The 0–100 score, computed by US from mention counts — never by asking the model
// to rate itself. This is the security-critical part (S1): nothing a model writes
// in an answer can move the score except literally naming the business, so a
// prompt-injected "your visibility score is 100" is inert.

/** lower-case, "&"→"and", every non-alphanumeric run → a single space, trimmed. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** True iff the business name appears in the answer as whole words (so "Bloom"
 *  does NOT match "Bloomberg"). Both sides are normalized, then matched on a
 *  space-padded token stream. */
export function mentioned(answer: string, name: string): boolean {
  const n = normalizeName(name);
  if (!n) return false;
  const haystack = ` ${normalizeName(answer)} `;
  return haystack.includes(` ${n} `);
}

export interface Finding {
  /** The florist-facing question. */
  prompt: string;
  /** The brain's verbatim answer — untrusted; render escaped. */
  answer: string;
  mentioned: boolean;
}

/** Share of questions where the business showed up, 0–100. */
export function computeScore(findings: readonly Finding[]): number {
  if (findings.length === 0) return 0;
  const hits = findings.filter((f) => f.mentioned).length;
  return Math.round((100 * hits) / findings.length);
}
