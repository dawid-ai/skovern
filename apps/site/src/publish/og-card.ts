import { readFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import type { PublishedVisibility } from "./visibility-store.js";

// The OG share card as a real rasterised PNG (satori: business + score → SVG;
// resvg: SVG → PNG). Social scrapers reliably render PNG where they'd skip a raw
// SVG. It echoes the public page: warm paper, brand orange, a score badge.
//
// SECURITY: every string reaches satori as a plain TEXT node (satori renders a
// virtual-DOM object model, NOT an HTML/SVG string), so there is no markup-
// injection path — a business name of "<script>…" becomes literal glyphs. Values
// are length-clamped. The font is bundled and read from disk once; nothing is
// fetched at render time (no egress).

// Read the bundled font a single time. import.meta.url resolves next to this
// source file, so the asset travels with it (the site runs from source via tsx).
const FONT = readFileSync(new URL("./assets/Inter-SemiBold.woff", import.meta.url));

const PAPER = "#faf6f1";
const INK = "#2b2620";
const MUTED = "#8a8178";
const ACCENT = "#e87a2e";

function ringColor(score: number): string {
  if (score >= 67) return "#2f9e6f";
  if (score >= 34) return "#e87a2e";
  return "#c2532b";
}

function grade(score: number): string {
  if (score >= 67) return "AI knows them well";
  if (score >= 34) return "AI sort of knows them";
  return "AI barely knows them yet";
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// A tiny helper so the satori tree stays readable. `style` is a subset of CSS;
// children are text or nested nodes.
// why: satori's public type is a React-ish node the lib re-validates internally;
// a precise structural type here would just duplicate its own and fight tsx-less
// object literals. Kept local and narrow.
type Node = { type: string; props: { style: Record<string, unknown>; children?: unknown } };
function el(type: string, style: Record<string, unknown>, children?: unknown): Node {
  return { type, props: { style, children } };
}

export async function renderVisibilityCardPng(v: PublishedVisibility): Promise<Buffer> {
  const score = Math.max(0, Math.min(100, Math.round(v.score)));
  const business = clip(v.business.trim(), 34) || "Your business";
  const named = v.competitors.slice(0, 3).map((c) => clip(c, 22));
  const ring = ringColor(score);

  const tree = el(
    "div",
    {
      width: "100%",
      height: "100%",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      padding: "70px 76px",
      backgroundColor: PAPER,
      color: INK,
      fontFamily: "Inter",
    },
    [
      // brand row
      el("div", { display: "flex", alignItems: "center" }, [
        el(
          "div",
          {
            width: 44,
            height: 44,
            borderRadius: 12,
            backgroundColor: ACCENT,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 26,
            marginRight: 16,
          },
          "D",
        ),
        el(
          "div",
          { fontSize: 26, color: ACCENT, letterSpacing: 3, textTransform: "uppercase" },
          "Deskhand · AI Visibility",
        ),
      ]),
      // middle: name + grade on the left, score badge on the right
      el(
        "div",
        { display: "flex", alignItems: "center", justifyContent: "space-between" },
        [
          el("div", { display: "flex", flexDirection: "column", maxWidth: 640 }, [
            el("div", { fontSize: 68, lineHeight: 1.05 }, business),
            el("div", { fontSize: 32, color: MUTED, marginTop: 18 }, grade(score)),
          ]),
          el(
            "div",
            {
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              width: 260,
              height: 260,
              borderRadius: 130,
              border: `18px solid ${ring}`,
              backgroundColor: "#fffdfb",
            },
            [
              el("div", { fontSize: 108, color: ring, lineHeight: 1 }, String(score)),
              el("div", { fontSize: 28, color: MUTED, marginTop: 4 }, "out of 100"),
            ],
          ),
        ],
      ),
      // bottom: competitors + CTA
      el("div", { display: "flex", flexDirection: "column" }, [
        named.length
          ? el("div", { fontSize: 26, color: MUTED }, `AI also named: ${named.join("  ·  ")}`)
          : el("div", { fontSize: 26, color: MUTED }, "See what AI says about your business."),
        el(
          "div",
          { fontSize: 28, color: ACCENT, marginTop: 12 },
          "deskhand — the friendly assistant for small shops",
        ),
      ]),
    ],
  );

  const svg = await satori(tree as unknown as Parameters<typeof satori>[0], {
    width: 1200,
    height: 630,
    fonts: [{ name: "Inter", data: FONT, weight: 600, style: "normal" }],
  });
  return Buffer.from(new Resvg(svg).render().asPng());
}
