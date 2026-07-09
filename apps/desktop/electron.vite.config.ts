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
    // @deskhand/core is workspace TS source — bundle it instead of externalizing
    plugins: [externalizeDepsPlugin({ exclude: ["@deskhand/core"] })],
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
