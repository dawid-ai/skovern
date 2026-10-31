// Blog post: highlight the section you're reading, fill the progress bar, and
// wire the Copy link buttons.
export function startPost(): void {
  const links = [...document.querySelectorAll<HTMLAnchorElement>("#toc a")];
  const heads = links
    .map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1))))
    .filter((h): h is HTMLElement => h !== null);
  const body = document.getElementById("post-body");
  const bar = document.getElementById("progress");
  const mark = (): void => {
    let cur = 0;
    heads.forEach((h, i) => {
      if (h.getBoundingClientRect().top < innerHeight * 0.3) cur = i;
    });
    links.forEach((a, i) => a.classList.toggle("on", i === cur));
    if (body && bar) {
      const r = body.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - innerHeight * 0.6)));
      bar.style.transform = `scaleX(${p.toFixed(4)})`;
    }
  };
  addEventListener("scroll", mark, { passive: true });
  mark();

  document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) =>
    b.addEventListener("click", () => {
      const label = b.querySelector("span");
      void navigator.clipboard.writeText(b.dataset["copy"] ?? location.href).then(
        () => {
          if (label) label.textContent = "Copied";
          setTimeout(() => {
            if (label) label.textContent = "Copy link";
          }, 2000);
        },
        () => {
          if (label) label.textContent = "Couldn't copy";
        },
      );
    }),
  );
}
