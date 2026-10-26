import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The deploy files are part of the security boundary (loop 051 SECURE): base
// images pinned by digest, a hashed package manager, a read-only api, and no
// build-time telemetry. These read the files themselves, so a careless edit
// goes red here instead of shipping.

const repo = join(import.meta.dirname, "..", "..", "..", "..");
const read = (p: string): string => readFileSync(join(repo, p), "utf8");
const froms = (dockerfile: string): string[] => [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1] ?? "");

describe("deploy files", () => {
  it.each(["apps/site/Dockerfile", "apps/www/Dockerfile"])("%s pins every base image by digest", (p) => {
    const images = froms(read(p));
    expect(images.length).toBeGreaterThan(1);
    for (const image of images) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("runs the api as node over root-owned, read-only files", () => {
    const api = read("apps/site/Dockerfile");
    const runtime = api.slice(api.lastIndexOf("FROM "));
    expect(runtime).toMatch(/^COPY --from=build \/app \/app$/m);
    expect(runtime).not.toMatch(/--chown/);
    expect(runtime).toMatch(/^USER node$/m);
  });

  it("turns Astro telemetry off in the www image and in CI", () => {
    expect(read("apps/www/Dockerfile")).toMatch(/ASTRO_TELEMETRY_DISABLED=1/);
    expect(read(".github/workflows/ci.yml")).toMatch(/ASTRO_TELEMETRY_DISABLED: "1"/);
  });

  it("pins pnpm with a corepack hash", () => {
    const pkg = JSON.parse(read("package.json")) as { packageManager: string };
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
  });
});
