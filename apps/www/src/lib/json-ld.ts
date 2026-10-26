// JSON-LD goes into an inline <script type="application/ld+json">. JSON.stringify
// leaves "<" alone, so a post title containing "</script>" would end the tag
// early and turn the rest of the title into page markup. Writing every "<" as
// the JSON escape backslash-u003c keeps the parsed JSON identical and the tag
// unbreakable.
const ESCAPED_LT = `${String.fromCharCode(92)}u003c`;

export function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, ESCAPED_LT);
}
