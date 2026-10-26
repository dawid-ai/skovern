// Client-side copies of the api's waitlist rules (apps/site/src/waitlist/validate.ts),
// so most mistakes show under the field before a round trip. The api stays the
// authority: it re-checks everything and its messages win.

/** [value sent to the api, label shown to people]. Values match the api's list. */
export const BUSINESS_TYPES = [
  ["florist", "Florist"],
  ["cafe", "Bakery or café"],
  ["salon", "Salon or barber"],
  ["restaurant", "Restaurant"],
  ["retail", "Retail shop"],
  ["trades", "Trades (plumber, electrician…)"],
  ["fitness", "Fitness studio"],
  ["wellness", "Health and wellness"],
  ["services", "Professional services"],
  ["other", "Other"],
] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URLISH = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;

export function nameError(name: string): string {
  if (!name) return "Tell us what to call you.";
  if (name.length > 80) return "That name is a bit long. A first name is plenty.";
  return "";
}

export function emailError(email: string): string {
  if (!email) return "We need an email to save your spot.";
  if (!EMAIL.test(email)) return "That email looks off. Check for a typo?";
  return "";
}

export function urlError(url: string): string {
  if (!url) return "";
  if (url.length > 200) return "That web address is too long.";
  if (!URLISH.test(url)) return "That doesn't look like a web address. Try something like bloomandvine.shop.";
  return "";
}

export function jobError(job: string): string {
  return job.length > 80 ? "Keep it under 80 letters." : "";
}

export const MESSAGES = {
  offline: "Couldn't reach us, try again.",
  busy: "Lots of tries from here. Wait a few minutes and try again.",
  timedOut: "This form timed out. Your spot is saved, so you can skip this.",
  saving: "Saving your spot…",
  sending: "Sending…",
} as const;
