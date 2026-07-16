// The content calendar. This is the news feed's source of truth: edit this
// file to publish. main.ts upserts every post into the news_posts table on
// boot (keyed by slug), so a change here goes live on the next deploy — no
// admin UI, git is the CMS. An admin publish endpoint lands in loop 006.

export interface NewsPost {
  /** Stable URL-safe id, also the primary key. Never reuse a slug. */
  slug: string;
  title: string;
  /** Markdown. Served as raw text; the renderer that displays it must treat
   *  it as untrusted and sanitize (loop 007). */
  body: string;
  /** ISO 8601. The feed sorts on this, newest first. */
  publishedAt: string;
}

export const POSTS: NewsPost[] = [
  {
    slug: "hello",
    title: "Skovern is being built in the open",
    body:
      "Hi! This is the very first note in Skovern's news feed.\n\n" +
      "Skovern is a free assistant for your business that runs on your own " +
      "computer. We're building it out loud — every week there's something new " +
      "to show, and it'll all show up right here.",
    publishedAt: "2026-07-09T09:00:00.000Z",
  },
  {
    slug: "accounts-and-sign-in",
    title: "You can now make an account",
    body:
      "Accounts are live. Pop in your email and we send you a link — click it " +
      "and you're in. No password to remember, nothing to lose.\n\n" +
      "You don't need an account to use Skovern. It just unlocks the news, a " +
      "direct line to us, and your founding-user number.",
    publishedAt: "2026-07-09T15:00:00.000Z",
  },
  {
    slug: "the-server-can-stand-on-its-own",
    title: "Behind the scenes: the server now runs by itself",
    body:
      "This one's for the tinkerers. Skovern's little cloud helper is now a " +
      "real program you can start on its own. Most folks will never see it — " +
      "but it's the plumbing that makes accounts and this news feed work.",
    publishedAt: "2026-07-10T10:00:00.000Z",
  },
];
