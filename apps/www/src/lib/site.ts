// Site-wide constants. The API base is fixed at build time: production talks to
// api.skovern.com; `astro dev` talks to a local api server; tests pass their own.
export const SITE_URL = "https://skovern.com";
export const SITE_NAME = "Skovern";

const fromEnv = (import.meta.env.PUBLIC_API_URL as string | undefined)?.trim();
export const API_URL = (fromEnv || (import.meta.env.MODE === "development" ? "http://127.0.0.1:41787" : "https://api.skovern.com")).replace(
  /\/$/,
  "",
);

export const DEFAULT_DESCRIPTION =
  "Skovern is free AI for your shop. It answers customers, writes your posts, and handles the busywork, and you control what leaves your computer. Join the waitlist.";

/**
 * The address people can write to about their data. TODO(contact): set this to
 * hi@skovern.com once that mailbox receives mail (Dawid is setting it up). Until
 * then no page shows an address, because a bouncing one is worse than none.
 */
export const CONTACT_EMAIL: string | null = null;
