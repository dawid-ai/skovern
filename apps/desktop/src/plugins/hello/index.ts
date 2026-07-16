import type { Plugin } from "@skovern/plugin-sdk";
import { helloManifest } from "./manifest.js";

// The fixture skill: proves the whole runtime end to end. It only knows how to ask
// for a page — it has no fs, no network, no brain of its own. `ctx.fetch` is a stub
// that RPCs the host, which authorizes + performs the fetch and receipts it. If the
// capability wasn't granted, `ctx.fetch` isn't even present.
export const helloPlugin: Plugin = {
  manifest: helloManifest,
  async run(ctx, input) {
    if (!ctx.fetch) return "This skill needs permission to read the web, and it wasn't given.";
    const body = await ctx.fetch(input);
    const snippet = body.trim().slice(0, 200);
    return `Here's the start of that page: ${snippet}`;
  },
};
