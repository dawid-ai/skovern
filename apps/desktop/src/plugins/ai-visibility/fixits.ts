// Static, copyable suggestions keyed to the score band. v1 is advice only — the
// actionable versions (write schema, update your Google listing) are a later loop.
// Florist language: plain, warm, no jargon.

export function fixitsForScore(score: number): string[] {
  if (score >= 67) {
    return [
      "You're showing up well. Keep your website's About page clear about what you do and where.",
      "Ask a few happy customers to mention your name and town in their reviews — it keeps you top of mind for AI too.",
    ];
  }
  if (score >= 34) {
    return [
      "You show up sometimes. Put your business name, what you sell, and your town in plain text near the top of your homepage.",
      "Add a short FAQ page answering the questions customers actually ask — AI reads those to learn about you.",
      "Make sure your Google Business Profile is filled in and matches your website.",
    ];
  }
  return [
    "AI barely knows you yet. Start with a clear homepage: your name, what you do, and your town in plain words.",
    "Claim and fill in your Google Business Profile — it's the first place AI looks.",
    "Get listed in a couple of local directories so there's more than one place that mentions you.",
  ];
}
