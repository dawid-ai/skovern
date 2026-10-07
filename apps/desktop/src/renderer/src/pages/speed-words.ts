// Tokens per second → a florist's sentence (046). A token is roughly ¾ of a word. Always "about":
// it's an estimate from the hardware, not a measurement. Small numbers stay exact so "3" doesn't
// round to "5"; bigger ones round to the nearest 5 so they don't look falsely precise. Above
// FAST_WORDS the estimate overshoots for small models (bandwidth ÷ weights ignores per-token
// overhead) and no one reads that fast anyway, so it just says so (Dawid, 2026-10-07).
const FAST_WORDS = 50; // roughly 5× a fast reader

export function speedWords(tokPerSec: number | null): string | null {
  if (tokPerSec === null || !Number.isFinite(tokPerSec) || tokPerSec <= 0) return null;
  const words = tokPerSec * 0.75;
  if (words > FAST_WORDS) return "Writes faster than you can read";
  if (words < 1) return "Writes less than a word a second";
  const n = words < 10 ? Math.round(words) : Math.round(words / 5) * 5;
  return `Writes about ${n} ${n === 1 ? "word" : "words"} a second`;
}
