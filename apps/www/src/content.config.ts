import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { postSchema } from "./lib/post-schema";

// One Markdown file per post in src/content/blog/. The file name is the slug.
const blog = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/blog" }),
  schema: postSchema,
});

export const collections = { blog };
