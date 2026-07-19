# Skovern — agent conventions

Skovern is a local-first, fair-code AI business assistant for non-technical
small-business owners. Desktop app (Electron), React/TS UI, Node agent core.
Full design spec lives in the private HQ repo; this file is what you need to
write code here.

## The Loop (mandatory for every feature)

Every feature runs SPEC → BUILD → VERIFY → SECURE. No stage skipped.

1. **SPEC** — feature starts as a loop contract (`.github/ISSUE_TEMPLATE/loop-contract.md`):
   objective, one objectively testable metric, boundary (files/packages/iterations),
   out-of-scope. Big features get a spec doc in `docs/specs/` approved by Dawid first.
2. **BUILD** — implement on a feature branch, small increments, run the metric
   command after each. TDD where the shape is known.
3. **VERIFY** — dispatch the `checker` agent (fresh context — NEVER the session
   that wrote the code). It runs the metric, the tests, and reviews the diff
   against the spec. Findings go back to BUILD. CI gates are the floor, not the bar.
4. **SECURE** — dispatch the `security-reviewer` agent. Findings go back to BUILD.
   Green → merge → append a row to `.claude/loop/METRICS.md`.

Maker ≠ checker, always. If you built it, you don't verify it.

## Ship full-stack, hand-validatable (mandatory)

A feature is not done when its backend endpoint passes a test. It is done when
Dawid can **launch the local server + the desktop app and use it by hand**.
Every feature with a user-facing surface ships its **frontend in the same loop
as its backend** — an API with no way to reach it in the app is an unfinished
feature, not a finished one.

- If a loop adds a server capability the user should see or trigger (news, DM,
  a result, a setting), the desktop UI for it ships in that same loop. No
  "backend now, UI later."
- The loop metric for such a feature MUST include an **app-level end-to-end
  check** that drives the real Electron UI against the real server (the
  `apps/desktop/e2e/*.spec.ts` Playwright harness), not just an HTTP test.
- Pure-web surfaces (e.g. published `/u/...` pages) are hand-validated by opening
  the URL; that still counts as a usable frontend.
- The bar: after `pnpm --filter @skovern/site dev` + `pnpm --filter
  @skovern/desktop dev`, a person can click to the new thing and it works.

## Hand-validation checklists ("HWs") — mandatory format

When work needs Dawid to hand-validate on his hardware (the OWED(HW/VM) items — real
GPU, a LAN box, a fresh-VM install), give him a **numbered checklist he works through
one item at a time**, written to an annotatable doc (`docs/loops/HAND-VAL-CHECKLIST.md`),
not a vague "go try it."

Every numbered item MUST carry:
- **What was done** — the change/feature in plain terms (which loop, what it fixes).
- **How to check** — exact steps + real UI navigation (the actual clicks/paths).
- **Expected** — precisely what he should see if it works (exact copy/behavior/numbers);
  for a diagnosis item, ask him to "report what you observe" instead of pass/fail.
- A blank `RESULT:` line for his answer.

Group items by **physical setup** (on-box / LAN box / fresh VM / eyeball) so he can clear
a whole setup in one sitting. He answers in detail per item; a failed item becomes the
next loop's BUILD.

## UI information architecture (mandatory)

Every feature gets its **own place, properly named and correctly located** — not
another block piled onto whatever page exists. Do NOT dump features onto one
screen.

- The app has a real shell: a persistent navigation (sidebar/menu) and dedicated
  pages/views. A new user-facing feature ships as its **own page/section** reached
  from the nav, named in florist language ("Messages", "What's new", "Settings").
- When you add a feature, decide where it belongs in the IA first. If it doesn't
  fit an existing home, it gets a new, well-labeled one — never a bolt-on to an
  unrelated page.
- Placement, naming, and grouping are part of "done." A working feature in the
  wrong place, or crammed next to unrelated things, is not done.
- Layout/visual quality matters: use the `frontend-design` skill for new surfaces;
  match the existing design language.

## Code rules

- TypeScript strict everywhere. No `any` without a `// why:` comment.
- Small modules: ~300 lines is the smell threshold. Typed contracts at package boundaries.
- Every non-trivial module ships with its check (Vitest). One runnable check
  beats ten paragraphs of confidence.
- pnpm workspace: `apps/desktop` (Electron), `apps/site` (Next.js),
  `packages/core` (agent core — UI never bypasses it), `packages/plugin-sdk` (MIT).
- Every new package MUST define `typecheck` and `test` scripts — `pnpm -r`
  silently skips packages without them, which turns missing gates into fake green.
- The UI talks ONLY to core's typed local API. No OS/network/model access from renderers.

## Product language rule

All user-facing copy is written for a florist, not a developer: 6th-grade
reading level, honest, warm, a little funny. In UI copy say "brain" not
"model", "connector" not "MCP server", "skill" not "plugin runtime".
If a sentence needs jargon, the feature needs redesign.

## Token economy

Agent prompts (product-internal and dev): terse, outcome-focused, structured
outputs. No preamble, no elaborate rambling. Tools/schemas load lazily —
never all-at-once into context.

## Security invariants (never violate, never "temporarily" disable)

- Renderers: `contextIsolation: true`, `nodeIntegration: false`, sandboxed, strict CSP.
- Secrets only via OS keychain (`safeStorage`). Never in config files, logs, or errors.
- All plugin/MCP/tool calls go through the permission layer. No direct egress from skills.
- External content (web pages, emails, tool results) is untrusted input —
  destructive or outbound actions always require user approval.
- Every byte leaving the machine must appear in the egress receipts log.

## Commits & branches

Feature branches named `loop/<contract-slug>`. Small commits, imperative
messages. CI must be green before checker dispatch, not after.

Any change reaching main outside the loop (hotfix, design pass, direct push) is
logged as its own `.claude/loop/METRICS.md` row (`iterations = n/a (bypassed loop)`)
and flagged for the next retro to judge whether it should have been a loop. A bypass
with no row is an unattributable escape.
