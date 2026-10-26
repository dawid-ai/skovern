import { z } from "astro/zod";

// Front matter rules for blog posts. A post missing any required field fails
// the build (W3). Authors stay in the schema so a second writer is one line.
export const AUTHORS = {
  dawid: { name: "Dawid", role: "founder" },
} as const;

export const CATEGORIES = {
  guides: "Guides",
  privacy: "Privacy",
  stories: "Shop stories",
  news: "Product news",
} as const;

/** Cover art for cards and the post header, drawn from shared site images. */
export const COVERS = ["icon", "icon-dark", "chat", "brain", "receipts", "update"] as const;

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const postSchema = z.object({
  title: z.string().min(8).max(140),
  description: z.string().min(20).max(300),
  date: z.coerce.date(),
  updated: z.coerce.date().optional(),
  category: z.enum(Object.keys(CATEGORIES) as [keyof typeof CATEGORIES, ...(keyof typeof CATEGORIES)[]]),
  author: z.enum(Object.keys(AUTHORS) as [keyof typeof AUTHORS]).default("dawid"),
  cover: z.enum(COVERS).default("icon"),
  coverAlt: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  draft: z.boolean().default(false),
});

export type PostData = z.infer<typeof postSchema>;
