import { MESSAGES, emailError, jobError, nameError, urlError } from "../lib/waitlist-rules";

// Runs the two-step waitlist form in place against the api. It never shows a
// success it didn't get: the number on screen is the number the api returned.

type Field = HTMLInputElement | HTMLSelectElement;
interface ApiError { field?: string; message?: string }

const TIMEOUT_MS = 12_000;

function q<T extends Element>(root: ParentNode, sel: string): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`waitlist: missing ${sel}`);
  return el;
}

function setErr(host: HTMLElement, input: Field, msg: string): boolean {
  const box = host.querySelector(`#${input.getAttribute("aria-describedby")}`);
  if (box) box.textContent = msg;
  if (msg) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
  return !msg;
}

function setAlert(form: HTMLFormElement, msg: string): void {
  const alert = q<HTMLElement>(form, ".wl-alert");
  alert.textContent = msg;
  alert.hidden = !msg;
}

function show(el: HTMLElement): void {
  el.hidden = false;
  el.classList.remove("in");
  void el.offsetWidth;
  el.classList.add("in");
}

/** POST JSON; resolves to the Response, or null when the api can't be reached. */
async function post(url: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      credentials: "omit",
    });
  } catch {
    return null;
  }
}

async function readError(res: Response): Promise<ApiError> {
  try {
    return (await res.json()) as ApiError;
  } catch {
    return {};
  }
}

function busy(btn: HTMLButtonElement, label: string | null): void {
  if (label) {
    btn.dataset["label"] = btn.textContent ?? "";
    btn.textContent = label;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset["label"] ?? btn.textContent;
    btn.disabled = false;
  }
}

export function mount(host: HTMLElement): void {
  if (host.dataset["mounted"]) return;
  host.dataset["mounted"] = "1";
  const api = host.dataset["api"] ?? "";
  const s1 = q<HTMLFormElement>(host, ".wl-s1");
  const s2wrap = q<HTMLElement>(host, ".wl-s2wrap");
  const s2 = q<HTMLFormElement>(host, ".wl-s2");
  const done = q<HTMLElement>(host, ".wl-done");
  const f = {
    name: q<HTMLInputElement>(s1, "[name=name]"),
    email: q<HTMLInputElement>(s1, "[name=email]"),
    hp: q<HTMLInputElement>(s1, "[name=company_website]"),
    job: q<HTMLInputElement>(s2, "[name=job]"),
    type: q<HTMLSelectElement>(s2, "[name=type]"),
    url: q<HTMLInputElement>(s2, "[name=url]"),
  };
  const byApiField: Record<string, Field> = {
    name: f.name, email: f.email, jobTitle: f.job, businessType: f.type, url: f.url,
  };
  const who = { name: "", email: "", n: 0, token: "" };
  s1.noValidate = true;

  host.querySelectorAll<Field>("input,select").forEach((i) =>
    i.addEventListener("input", () => {
      if (i.getAttribute("aria-invalid")) setErr(host, i, "");
    }),
  );

  s1.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void (async () => {
      const name = f.name.value.trim();
      const email = f.email.value.trim();
      setAlert(s1, "");
      const okN = setErr(host, f.name, nameError(name));
      const okE = setErr(host, f.email, emailError(email));
      if (!okN || !okE) return (okN ? f.email : f.name).focus();
      const btn = q<HTMLButtonElement>(s1, "button[type=submit]");
      busy(btn, MESSAGES.saving);
      const res = await post(`${api}/api/waitlist`, { name, email, company_website: f.hp.value });
      busy(btn, null);
      if (!res) return setAlert(s1, MESSAGES.offline);
      if (res.status === 429) return setAlert(s1, MESSAGES.busy);
      if (res.status === 400) {
        const e = await readError(res);
        const input = byApiField[e.field ?? ""];
        if (input) return void (setErr(host, input, e.message ?? ""), input.focus());
        return setAlert(s1, e.message ?? MESSAGES.offline);
      }
      if (res.status !== 201) return setAlert(s1, MESSAGES.offline);
      const body = (await res.json()) as { number: number; detailsToken: string };
      who.name = name.split(/\s+/)[0] ?? name;
      who.email = email;
      who.n = body.number;
      who.token = body.detailsToken;
      s1.hidden = true;
      show(s2wrap);
      host.querySelectorAll(".wl-num").forEach((n) => (n.textContent = `#${who.n}`));
      const h = q<HTMLElement>(host, ".wl-okh");
      h.innerHTML = '<span class="wl-check" aria-hidden="true">✓</span>';
      h.append(`You're on the list, ${who.name}. You're #${who.n}.`);
      h.focus({ preventScroll: true });
    })();
  });

  const finish = (sent: boolean, extra: string[]): void => {
    s2wrap.hidden = true;
    show(done);
    q<HTMLElement>(host, ".wl-doneh").textContent = sent ? `Thanks, ${who.name}. That helps a lot.` : `All set, ${who.name}.`;
    q<HTMLElement>(host, ".wl-donep").textContent = sent
      ? `We'll use it to shape Skovern for shops like yours. You're still #${who.n}.`
      : `You're #${who.n} on the list. No extra questions.`;
    const sum = q<HTMLElement>(host, ".wl-sum");
    sum.replaceChildren(
      ...extra.filter(Boolean).map((x) => Object.assign(document.createElement("span"), { textContent: x })),
    );
    q<HTMLElement>(host, ".wl-donemail").textContent = `We'll write to ${who.email} when your invite is ready.`;
    q<HTMLElement>(host, ".wl-doneh").focus({ preventScroll: true });
  };

  s2.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void (async () => {
      const job = f.job.value.trim();
      const type = f.type.value;
      const url = f.url.value.trim();
      setAlert(s2, "");
      const okU = setErr(host, f.url, urlError(url));
      const okJ = setErr(host, f.job, jobError(job));
      const any = Boolean(job || type || url);
      setErr(host, f.type, any ? "" : "Fill in at least one, or tap Skip.");
      if (!okU) return f.url.focus();
      if (!okJ || !any) return f.job.focus();
      const btn = q<HTMLButtonElement>(s2, "button[type=submit]");
      busy(btn, MESSAGES.sending);
      const res = await post(`${api}/api/waitlist/details`, {
        detailsToken: who.token,
        jobTitle: job || undefined,
        businessType: type || undefined,
        url: url || undefined,
      });
      busy(btn, null);
      if (!res) return setAlert(s2, MESSAGES.offline);
      if (res.status === 429) return setAlert(s2, MESSAGES.busy);
      if (res.status === 400) {
        const e = await readError(res);
        const input = byApiField[e.field ?? ""];
        if (input) return void (setErr(host, input, e.message ?? ""), input.focus());
        return setAlert(s2, e.message ?? MESSAGES.timedOut);
      }
      if (res.status !== 204) return setAlert(s2, MESSAGES.offline);
      const typeLabel = type ? (f.type.selectedOptions[0]?.textContent ?? "") : "";
      finish(true, [job, typeLabel, url.replace(/^https?:\/\//i, "")]);
    })();
  });

  q<HTMLButtonElement>(host, "[data-skip]").addEventListener("click", () => finish(false, []));
  q<HTMLButtonElement>(host, "[data-reset]").addEventListener("click", () => {
    s1.reset();
    s2.reset();
    host.querySelectorAll<Field>("[aria-invalid]").forEach((i) => setErr(host, i, ""));
    done.hidden = true;
    s2wrap.hidden = true;
    show(s1);
    f.name.focus();
  });
}

export function mountAll(): void {
  document.querySelectorAll<HTMLElement>("[data-waitlist]").forEach(mount);
}
