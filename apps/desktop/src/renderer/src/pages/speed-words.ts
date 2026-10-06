// Tokens per second → a florist's sentence (046). A token is roughly ¾ of a word. Always "about":
// it's an estimate from the hardware, not a measurement. Small numbers stay exact so "3" doesn't
// round to "5"; bigger ones round to the nearest 5 so they don't look falsely precise.
export function speedWords(tokPerSec: number | null): string | null {
  if (tokPerSec === null || !Number.isFinite(tokPerSec) || tokPerSec <= 0) return null;
  const words = tokPerSec * 0.75;
  if (words < 1) return "Writes less than a word a second";
  const n = words < 10 ? Math.round(words) : Math.round(words / 5) * 5;
  return `Writes about ${n} ${n === 1 ? "word" : "words"} a second`;
}
