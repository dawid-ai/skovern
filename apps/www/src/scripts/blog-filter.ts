// Topic chips and search on the blog index. Pure filtering of what's already on
// the page; nothing is fetched.
export function startBlogFilter(): void {
  const cards = [...document.querySelectorAll<HTMLElement>("#cards .pcard")];
  const chips = [...document.querySelectorAll<HTMLButtonElement>("[data-f]")];
  const q = document.querySelector<HTMLInputElement>("#q");
  const empty = document.querySelector<HTMLElement>("#empty");
  const count = document.querySelector<HTMLElement>("#count");
  if (!q || !empty || !count || !cards.length) return;
  let cat = "all";
  const apply = (): void => {
    const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const c of cards) {
      const text = (c.textContent ?? "").toLowerCase();
      const ok = (cat === "all" || c.dataset["cat"] === cat) && words.every((w) => text.includes(w));
      c.hidden = !ok;
      if (ok) shown += 1;
    }
    empty.hidden = shown > 0;
    count.textContent = shown === 1 ? "1 post" : `${shown} posts`;
  };
  chips.forEach((b) =>
    b.addEventListener("click", () => {
      cat = b.dataset["f"] ?? "all";
      chips.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      apply();
    }),
  );
  q.addEventListener("input", apply);
  // Deep links like /blog/#guides pick that topic.
  const fromHash = location.hash.slice(1);
  chips.find((c) => c.dataset["f"] === fromHash)?.click();
}
