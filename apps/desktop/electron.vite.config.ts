import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

const STRICT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
// dev only: vite injects styles inline and HMR needs its websocket.
// NOTE: vite's inline refresh preamble is head-prepended ABOVE this meta, so
// script-src never evaluates it — dev works by ordering. If a plugin change
// ever breaks dev scripts, the fix is vite's html.cspNonce + 'nonce-…' here,
// NEVER script-src 'unsafe-inline'.
const DEV_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'";

function injectCsp(policy: string, apply: "build" | "serve"): Plugin {
  return {
    name: `deskhand-csp-${apply}`,
    apply,
    transformIndexHtml(html) {
      if (!html.includes("<!-- CSP -->")) {
        throw new Error("index.html is missing the <!-- CSP --> placeholder — refusing to ship without a CSP");
      }
      return html.replace(
        "<!-- CSP -->",
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      );
    },
  };
}

export default defineConfig({
  main: {
    // @deskhand/core + plugin-sdk are workspace TS source — bundle, don't externalize.
    // node-llama-cpp is an OPTIONAL native dep (not in `dependencies`, so not auto-
    // externalized) — force it external so the llama-child never bundles its native
    // internals (which import per-platform binary packages that aren't all installed).
    plugins: [externalizeDepsPlugin({ exclude: ["@deskhand/core", "@deskhand/plugin-sdk"], include: ["node-llama-cpp"] })],
    build: {
      rollupOptions: {
        // Second entry: the sandboxed child. Emitted as a fully-bundled .mjs (no bare
        // imports) so it loads under the Permission Model reading only its own entry.
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "plugin-child": resolve(__dirname, "src/plugin-child/index.ts"),
          // The embedded-runtime child. Built like `index` (deps externalized — it must
          // resolve the native node-llama-cpp at runtime), NOT bundled like plugin-child.
          "llama-child": resolve(__dirname, "src/main/llama-child.ts"),
        },
        output: {
          entryFileNames: (chunk) => (chunk.name === "plugin-child" ? "plugin-child.mjs" : "[name].js"),
          // .mjs so the sandboxed child's code (entry + shared chunks) is ESM by
          // extension — no package.json walk that the Permission Model would deny.
          chunkFileNames: "chunks/[name].mjs",
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // sandboxed preloads must be CJS
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    plugins: [react(), injectCsp(STRICT_CSP, "build"), injectCsp(DEV_CSP, "serve")],
  },
});
