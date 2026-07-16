import type { PluginManifest } from "@skovern/plugin-sdk";

// AI Visibility — the wow wedge (spec §8), now a real skill. Split from run so the
// HOST (broker + permission card) and the sandboxed CHILD read the same declaration.
// It only asks for `brain`: no fs, no network of its own. Copy stays honest — it
// checks YOUR configured brain, not "every AI everywhere" (that's a later loop).
export const aiVisibilityManifest: PluginManifest = {
  id: "ai-visibility",
  name: "AI Visibility",
  description: "See what your assistant's brain tells customers about your business.",
  capabilities: ["brain"],
};
