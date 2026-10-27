import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Loop 054: a select's `appearance` is declared in select.css only. controls.css used to set
// `appearance: none` on select with the same specificity as select.css's base-select, so
// whichever file loaded last decided whether the list was themed or the OS popup.

const dir = import.meta.dirname;
const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** [selector, body] for every rule, flattening @supports and @media blocks. */
function rules(css: string): [string, string][] {
  const out: [string, string][] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of strip(css).matchAll(re)) out.push([m[1]!.trim(), m[2]!]);
  return out;
}

const selectsSelect = (sel: string): boolean =>
  sel.split(",").some((s) => /(^|[\s>+~])select(?![-\w])(?!::picker)/.test(s.trim()) && !/^@/.test(s.trim()));

describe("select appearance has one home", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".css"));

  it("no stylesheet but select.css sets appearance on a select", () => {
    const offenders = files
      .filter((f) => f !== "select.css")
      .flatMap((f) => rules(readFileSync(join(dir, f), "utf8")).filter(([sel, body]) => selectsSelect(sel) && /(^|;|\s)appearance\s*:/.test(body)).map(([sel]) => `${f}: ${sel}`));
    expect(offenders).toEqual([]);
  });

  it("select.css makes selects base-select where supported", () => {
    const css = strip(readFileSync(join(dir, "select.css"), "utf8"));
    expect(css).toMatch(/@supports\s*\(appearance:\s*base-select\)\s*\{\s*select,\s*::picker\(select\)\s*\{\s*appearance:\s*base-select;/);
  });
});
