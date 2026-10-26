// The no-JS landing pages, improved when scripts run: show the number on the
// done page, and the specific reason on the oops page.
const WHY: Record<string, string> = {
  name: "Check your name: letters only, and a short one is plenty. Then try again.",
  email: "Check your email address for a typo, and try again.",
  busy: "Lots of tries from here. Wait a few minutes and try again.",
};

export function showNumber(): void {
  const n = new URLSearchParams(location.search).get("n");
  const num = document.getElementById("done-num");
  if (num && n && /^\d{1,9}$/.test(n)) num.textContent = `#${n}`;
}

export function explainOops(): void {
  const error = new URLSearchParams(location.search).get("error") ?? "";
  const why = document.getElementById("oops-why");
  const text = WHY[error];
  if (why && text) why.textContent = text;
}
