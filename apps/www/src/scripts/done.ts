// /waitlist/done/: show the number (or the problem) the api sent back.
const WHY: Record<string, string> = {
  name: "We need your name, and a short one is plenty.",
  email: "That email looked off. Check for a typo and try again.",
};

export function startDone(): void {
  const q = new URLSearchParams(location.search);
  const n = q.get("n");
  const error = q.get("error");
  const ok = document.querySelector<HTMLElement>("[data-ok]");
  const bad = document.querySelector<HTMLElement>("[data-error]");
  if (error && ok && bad) {
    ok.hidden = true;
    bad.hidden = false;
    const why = document.getElementById("done-why");
    if (why) why.textContent = WHY[error] ?? "Something in the form needs a fix.";
    return;
  }
  const num = document.getElementById("done-num");
  if (num && n && /^\d{1,9}$/.test(n)) num.textContent = `#${n}`;
}
