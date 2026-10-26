// Home page motion: reveal on scroll, the live feature tiles, the receipts
// orbit, and the nav turning dark over the black section. Everything settles to
// its finished state at once when the reader prefers reduced motion.

const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = <T extends Element = HTMLElement>(s: string): T | null => document.querySelector<T>(s);
const clamp = (v: number, a = 0, b = 1): number => Math.min(b, Math.max(a, v));
const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const out = (t: number): number => 1 - Math.pow(1 - t, 3);
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, reduce ? 0 : ms));

function tween(ms: number, fn: (t: number) => void, done?: () => void): void {
  if (reduce) {
    fn(1);
    done?.();
    return;
  }
  const t0 = performance.now();
  const step = (now: number): void => {
    const t = Math.min(1, (now - t0) / ms);
    fn(out(t));
    if (t < 1) requestAnimationFrame(step);
    else done?.();
  };
  requestAnimationFrame(step);
}

const runs: Record<string, () => Promise<void>> = {
  "t-receipts": async () => {
    const el = $("#rcount");
    if (el) tween(1600, (t) => (el.textContent = Math.round(1550 * t).toLocaleString("en-US")));
    const rows = [...document.querySelectorAll<HTMLElement>("#rlist .rrow")].sort(
      (a, b) => Number(a.dataset["i"]) - Number(b.dataset["i"]),
    );
    for (const r of rows) {
      await wait(650);
      r.classList.add("on");
      if (r.dataset["i"] !== "0" && !reduce) r.classList.add("new");
    }
  },
  "t-brain": async () => {
    const fg = $("#ringFg"), pct = $("#ringPct"), step = $("#bstep"), card = $("#bcard");
    if (!fg || !pct || !step || !card) return;
    const C = 339.3;
    await wait(400);
    tween(
      3600,
      (t) => {
        fg.style.strokeDashoffset = (C * (1 - t)).toFixed(1);
        pct.textContent = `${Math.round(t * 100)}%`;
        step.textContent =
          t < 0.15 ? "Checking your computer…" : t < 0.32 ? "Setting up Ollama for you…" : `Getting your brain · ${((9 * (t - 0.32)) / 0.68).toFixed(1)} of 9.0 GB`;
      },
      () => {
        card.classList.add("done");
        step.textContent = "Ready. Say hi.";
      },
    );
  },
  "t-updates": async () => {
    await wait(500);
    $("#notice")?.classList.add("show");
  },
};

function reveal(): void {
  const io = new IntersectionObserver(
    (es) =>
      es.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add("in");
        io.unobserve(e.target);
        const f = runs[e.target.id];
        if (f) setTimeout(() => void f(), reduce ? 0 : 350);
      }),
    { threshold: 0.15, rootMargin: "0px 0px -6% 0px" },
  );
  document.querySelectorAll("[data-rv], [data-reveal]").forEach((el) => io.observe(el));
}

function updateNotice(): void {
  const nH = $("#nH"), nP = $("#nP"), nAct = $("#nAct"), notice = $("#notice");
  if (!nH || !nP || !nAct || !notice) return;
  const btn = (label: string, n: string, gray = false): HTMLButtonElement =>
    Object.assign(document.createElement("button"), { className: gray ? "nbtn gray" : "nbtn", textContent: label, type: "button", dataset: { n } });
  const offer = (): void => {
    nH.textContent = "A new Skovern is here (0.1.1).";
    nP.textContent = "Chats open faster, your brain says when it's asleep, and long receipts no longer get cut off.";
    nAct.replaceChildren(btn("Later", "later", true), btn("Update now", "update"));
  };
  nAct.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("[data-n]")?.dataset["n"];
    if (a === "later") {
      notice.classList.remove("show");
      setTimeout(() => {
        offer();
        notice.classList.add("show");
      }, reduce ? 0 : 2200);
    } else if (a === "update") {
      const bar = document.createElement("span");
      const track = Object.assign(document.createElement("span"), { className: "nbar" });
      track.style.display = "block";
      track.append(bar);
      nP.replaceChildren(track);
      nAct.replaceChildren(btn("Later", "later", true));
      tween(
        2200,
        (t) => {
          bar.style.width = `${t * 100}%`;
          nH.textContent = `Getting the update… ${Math.round(t * 100)}%`;
        },
        () => {
          nH.textContent = "The update is ready. Restart Skovern to finish.";
          nP.textContent = "If you pick Later, it installs the next time you quit Skovern.";
          nAct.replaceChildren(btn("Later", "later", true), btn("Restart now", "restart"));
        },
      );
    } else if (a === "restart") {
      nH.textContent = "You're on Skovern 0.1.1.";
      nP.textContent = "That's it. Nothing else to do.";
      nAct.replaceChildren();
    }
  });
  document.querySelectorAll<HTMLButtonElement>("[data-get]").forEach((b) =>
    b.addEventListener("click", () => {
      const on = b.classList.toggle("on");
      b.textContent = on ? "Added" : "Get";
    }),
  );
}

/** Receipt cards orbit out of the icon (wide screens) or settle into a list (narrow). */
function orbit(): void {
  const cards = [...document.querySelectorAll<HTMLElement>("[data-c]")];
  const orbitEl = $("#orbit"), aRc = $("#a-rc"), pin = $("#rc-pin"), nav = $(".gnav"), rcSec = $("#receipts");
  if (!orbitEl || !aRc || !pin || !nav || !rcSec || !cards.length) return;
  const layout = (o: number): void => {
    const W = orbitEl.clientWidth, H = orbitEl.clientHeight, narrow = innerWidth < 760;
    const pb = narrow ? Math.min(96, H * 0.18) : Math.min(210, H * 0.36, W * 0.2);
    orbitEl.style.setProperty("--pb", `${pb}px`);
    const cw = narrow ? Math.min(W, 330) : 320;
    orbitEl.style.setProperty("--cw", `${cw}px`);
    const ch = cards[0]?.offsetHeight || 58;
    const emerge = clamp(o / 0.32);
    aRc.style.setProperty("--halo", emerge.toFixed(3));
    cards.forEach((c, i) => {
      let x: number, y: number, s: number, op: number, z: number;
      if (!narrow) {
        const rx = Math.min(W / 2 - cw / 2 - 8, 520);
        const ry = Math.max(pb * 0.45 + ch / 2 + 26, Math.min(H / 2 - ch / 2 - 6, pb * 0.66 + ch));
        const ang = -Math.PI / 2 + (i / cards.length) * Math.PI * 2 + o * Math.PI * 1.3;
        const r = ease(clamp((emerge - i * 0.08) / 0.6));
        const depth = Math.sin(ang);
        x = W / 2 + Math.cos(ang) * rx * r;
        y = H / 2 + depth * ry * r;
        s = mix(0.35, 0.84 + (0.16 * (depth + 1)) / 2, r);
        op = r * (0.42 + (0.58 * (depth + 1)) / 2);
        z = depth > 0 ? 40 : 1;
      } else {
        const t = ease(clamp((emerge * 1.4 - i * 0.12) / 0.6));
        const top = H * 0.5 - 0.5 * (cards.length * (ch + 8));
        const slotY = top + i * (ch + 6) + ch / 2 + pb * 0.5;
        x = W / 2;
        y = mix(H / 2 - pb * 0.2, slotY, t);
        s = mix(0.3, 1, t);
        op = t;
        z = 40;
      }
      c.style.transform = `translate(${(x - cw / 2).toFixed(1)}px, ${(y - ch / 2).toFixed(1)}px) scale(${s.toFixed(3)})`;
      c.style.opacity = op.toFixed(3);
      c.style.zIndex = String(z);
    });
    aRc.style.top = narrow ? `${mix(50, 14, ease(clamp(emerge * 1.3)))}%` : "50%";
  };
  const navTone = (): void => {
    const r = rcSec.getBoundingClientRect();
    nav.classList.toggle("dark", r.top <= 24 && r.bottom >= 24);
  };
  addEventListener("scroll", navTone, { passive: true });
  navTone();
  if (reduce) {
    const fix = (): void => layout(0.55);
    addEventListener("resize", fix);
    fix();
    return;
  }
  const progress = (): number => {
    const r = pin.getBoundingClientRect();
    return clamp(-r.top / Math.max(1, r.height - innerHeight));
  };
  let queued = false;
  const tick = (): void => {
    queued = false;
    layout(progress());
  };
  const schedule = (): void => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(tick);
  };
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
  tick();
}

/** Every Join button lands on the form with the cursor in the first field. */
function joinFocus(): void {
  document.documentElement.style.scrollBehavior = reduce ? "auto" : "smooth";
  document.querySelectorAll("[data-join]").forEach((a) =>
    a.addEventListener("click", () => {
      setTimeout(() => {
        const i = document.querySelector<HTMLInputElement>("#waitlist .wl-s1:not([hidden]) input[name=name]");
        i?.focus({ preventScroll: true });
      }, reduce ? 0 : 700);
    }),
  );
}

export function startHome(): void {
  reveal();
  updateNotice();
  orbit();
  joinFocus();
}
