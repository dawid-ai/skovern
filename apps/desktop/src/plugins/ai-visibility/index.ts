import type { Plugin } from "@skovern/plugin-sdk";
import { aiVisibilityManifest } from "./manifest.js";
import { buildPrompts, type BusinessInput } from "./prompts.js";
import { computeScore, mentioned, type Finding } from "./score.js";
import { parseCompetitors } from "./competitors.js";
import { fixitsForScore } from "./fixits.js";
import type { AiVisibilityResult } from "./result.js";

// The wow wedge as a skill. It asks the brain a fixed set of questions about the
// user's business, then WE score it from mention counts + pull competitors — the
// model never rates itself. Input/output cross the host boundary as strings: input
// is a JSON {name, category, city}; output is a JSON AiVisibilityResult the result
// view renders (escaped). The brain is the only power it holds.

function parseInput(input: string): BusinessInput {
  let raw: unknown;
  try {
    raw = JSON.parse(input);
  } catch {
    throw new Error("bad input");
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) throw new Error("business name required");
  return {
    name,
    category: typeof o.category === "string" ? o.category : "",
    city: typeof o.city === "string" ? o.city : "",
  };
}

export const aiVisibilityPlugin: Plugin = {
  manifest: aiVisibilityManifest,
  async run(ctx, input) {
    const business = parseInput(input);
    // The host only runs this skill when a brain is configured, but stay honest if not.
    if (!ctx.brain) throw new Error("no brain");

    const findings: Finding[] = [];
    let competitors: string[] = [];
    const prompts = buildPrompts(business);
    const total = prompts.length;
    for (let i = 0; i < total; i++) {
      const p = prompts[i]!;
      // Tell the UI which question we're on before we start waiting on the brain.
      ctx.progress?.(i + 1, total);
      const answer = await ctx.brain.generate(p.text);
      findings.push({ prompt: p.label, answer, scored: p.scored, mentioned: mentioned(answer, business.name) });
      if (p.kind === "competitors") competitors = parseCompetitors(answer, business.name);
    }

    const score = computeScore(findings);
    const result: AiVisibilityResult = {
      business: business.name,
      score,
      findings,
      competitors,
      fixits: fixitsForScore(score),
    };
    return JSON.stringify(result);
  },
};
