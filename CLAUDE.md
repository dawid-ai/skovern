# Deskhand — agent conventions

Deskhand is a local-first, fair-code AI business assistant for non-technical
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
