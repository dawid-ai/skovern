import { getCollection, type CollectionEntry } from "astro:content";
import { AUTHORS, CATEGORIES, SLUG } from "./post-schema";

export type Post = CollectionEntry<"blog">;

/** Published posts, newest first. Throws (failing the build) on a bad slug. */
export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection("blog", (p) => !p.data.draft);
  for (const p of posts) {
    if (!SLUG.test(p.id)) {
      throw new Error(`Blog post "${p.id}" needs a file name made of lowercase letters, numbers, and dashes.`);
    }
  }
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export function readMinutes(post: Post): number {
  const words = (post.body ?? "").replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

export const categoryLabel = (c: keyof typeof CATEGORIES): string => CATEGORIES[c];
export const author = (a: keyof typeof AUTHORS): (typeof AUTHORS)[keyof typeof AUTHORS] => AUTHORS[a];
export const postUrl = (p: Post): string => `/blog/${p.id}/`;
