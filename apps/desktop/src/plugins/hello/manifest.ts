import type { PluginManifest } from "@deskhand/plugin-sdk";

// The bundled fixture skill's manifest. Lives on its own so the HOST (which builds
// the broker + the permission card from it) and the sandboxed CHILD (which runs it)
// both read the exact same declaration — no looser copy on either side.
export const helloManifest: PluginManifest = {
  id: "hello",
  name: "Hello skill",
  description: "Reads a page from the web and shows you the first bit of it.",
  capabilities: ["fetch"],
};
