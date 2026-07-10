// One HTML/XML text-escaper, shared by every surface that renders user or
// admin content (DM admin thread, published pages, OG cards). A security
// primitive you don't want drifting between copies. Escapes the five chars
// that matter in element text, attribute values, and SVG text nodes.
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}
