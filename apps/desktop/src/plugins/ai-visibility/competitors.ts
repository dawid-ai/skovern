import { normalizeName } from "./score.js";

// Pull the competitor names out of the one answer that asked for a JSON array.
// The answer is untrusted model output: we parse defensively (bad/absent block →
// empty list, never a throw), exclude the business itself, dedupe, and cap both
// the count and each name's length so a hostile model can't flood the UI.

const MAX_COMPETITORS = 10;
const MAX_NAME_LEN = 80;

export function parseCompetitors(answer: string, businessName: string): string[] {
  const block = answer.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!block?.[1]) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(block[1]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const self = normalizeName(businessName);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const name = item.trim().slice(0, MAX_NAME_LEN);
    if (!name) continue;
    const key = normalizeName(name);
    if (!key || key === self || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_COMPETITORS) break;
  }
  return out;
}
