// The fixed set of questions we ask the brain, built from what the user told us
// about their business. Deterministic — same inputs, same prompts — so the score
// is reproducible. `label` is the florist-facing question shown next to each
// verbatim answer; `text` is what actually goes to the brain.

export interface BusinessInput {
  name: string;
  category: string;
  city: string;
}

export interface Prompt {
  /** Shown in the UI beside the answer. */
  label: string;
  /** Sent to the brain. */
  text: string;
  /** The one prompt we parse a competitor list out of. */
  kind: "mention" | "competitors";
}

export function buildPrompts({ name, category, city }: BusinessInput): Prompt[] {
  const cat = category.trim() || "business";
  const where = city.trim() ? ` in ${city.trim()}` : "";
  return [
    {
      label: `Do you know "${name}"?`,
      text: `What can you tell me about a ${cat} called "${name}"${where}? If you don't know it, say so plainly.`,
      kind: "mention",
    },
    {
      label: `Would you recommend a ${cat}${where}?`,
      text: `I'm looking for a good ${cat}${where}. Which ones would you recommend, and why?`,
      kind: "mention",
    },
    {
      label: `Is "${name}" a good choice?`,
      text: `Is "${name}" a good ${cat}${where}? What are people likely to say about it?`,
      kind: "mention",
    },
    {
      label: `Where should a customer go${where}?`,
      text: `If a friend asked you where to go for a ${cat}${where}, what would you tell them?`,
      kind: "mention",
    },
    {
      label: `Who are the top ${cat}s${where}?`,
      text:
        `List the top ${cat}s${where}. ` +
        `Return ONLY a JSON array of their names in a fenced \`\`\`json code block, nothing else.`,
      kind: "competitors",
    },
  ];
}
