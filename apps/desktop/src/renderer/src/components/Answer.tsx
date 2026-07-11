import Markdown from "react-markdown";

// Renders a brain answer (untrusted model output) as formatted text.
//
// SECURITY: react-markdown at its DEFAULT config only. No `rehype-raw`, so any
// raw HTML in the answer (e.g. "<script>…</script>") is treated as literal text,
// never parsed into live elements. react-markdown's built-in URL transform
// neutralises dangerous link protocols (a "javascript:" href is dropped). This
// is the whole reason we can render model output as markdown safely — do NOT add
// a raw-HTML plugin here.
export function Answer({ children }: { children: string }) {
  return (
    <div className="answer">
      <Markdown>{children}</Markdown>
    </div>
  );
}
