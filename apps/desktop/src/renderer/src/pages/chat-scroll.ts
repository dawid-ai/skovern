// Pure scroll math for the Chat thread — kept out of the component so it's unit-testable
// without a DOM (loop 034). The component measures the live DOM and feeds these numbers in.

export const BOTTOM_EPS = 8; // px slack: "at the bottom" needn't be pixel-exact

/** Is the thread scrolled to (within a hair of) the very bottom? When true, new content
 *  auto-follows; when the user scrolls up (false), auto-scroll pauses until they return. */
export function atBottom(scrollTop: number, clientHeight: number, scrollHeight: number, eps = BOTTOM_EPS): boolean {
  return scrollTop + clientHeight >= scrollHeight - eps;
}

/** The nearest reply offset strictly ABOVE the current position (jump-to-previous-reply),
 *  or null when there's none — we're at/above the first reply, so that button is disabled. */
export function prevOffset(offsets: number[], scrollTop: number, eps = BOTTOM_EPS): number | null {
  const above = offsets.filter((o) => o < scrollTop - eps);
  return above.length > 0 ? Math.max(...above) : null;
}

/** The nearest reply offset strictly BELOW the current position (jump-to-next-reply), or
 *  null when there's none — we're at/below the last reply, so that button is disabled. */
export function nextOffset(offsets: number[], scrollTop: number, eps = BOTTOM_EPS): number | null {
  const below = offsets.filter((o) => o > scrollTop + eps);
  return below.length > 0 ? Math.min(...below) : null;
}
