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
 *  space-padded token stream. Names under 2 chars never match — a single letter
 *  would over-count against any standalone letter in the answer. */
export function mentioned(answer: string, name: string): boolean {
  const n = normalizeName(name);
  if (n.length < 2) return false;
  const haystack = ` ${normalizeName(answer)} `;
  return haystack.includes(` ${n} `);
}

export interface Finding {
  /** The florist-facing question. */
  prompt: string;
  /** The brain's verbatim answer — untrusted; render escaped. */
  answer: string;
  /** Whether this question counts toward the score. Questions that HAND the brain
   *  the business name (a direct "what about X?") don't — the model parrots the
   *  name back even in a denial, which would fake visibility. Only unprompted-recall
   *  questions are scored, so the number means "how often AI brings you up itself." */
  scored: boolean;
  mentioned: boolean;
}

/** Share of the UNPROMPTED-RECALL questions where the business showed up, 0–100.
 *  Name-embedded questions are excluded so the model can't inflate the score by
 *  echoing its own prompt (see `Finding.scored`). */
export function computeScore(findings: readonly Finding[]): number {
  const scored = findings.filter((f) => f.scored);
  if (scored.length === 0) return 0;
  const hits = scored.filter((f) => f.mentioned).length;
  return Math.round((100 * hits) / scored.length);
}
