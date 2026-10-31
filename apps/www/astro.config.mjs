// @ts-check
import { defineConfig } from "astro/config";

// skovern.com is a fully static build served by Caddy (see Dockerfile).
// Stylesheets and scripts stay external files so the Content-Security-Policy
// can forbid inline script and style elements.
export default defineConfig({
  site: "https://skovern.com",
  output: "static",
  trailingSlash: "ignore",
  build: { format: "directory", inlineStylesheets: "never" },
  devToolbar: { enabled: false },
  vite: { build: { assetsInlineLimit: 0 } },
});
