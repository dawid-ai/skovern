# Local AI Chat — design spec (2026-07-14)

**Status:** approved by Dawid (2026-07-14), ready for implementation planning.

## Purpose

A ChatGPT/Claude-style chat with the user's **local brain** (private, on-computer),
with separate chats, persistent history, full-content search, and live streaming
replies. It is the first "official extension" and will later become the **reference /
boilerplate** the extension system is extracted from — but v1 is built **first-party**
(it bypasses the current stateless task-runner plugin sandbox, which cannot express a
UI+storage+streaming app). See `HANDOFF.md` and the architecture recon for why.

## Decisions (locked in brainstorming)

1. **Brain scope: local-first, cloud allowed.** Chat talks to the user's configured
   brain via the existing loop-011 `Router` (`buildRouter()`). Framed as private local
   chat; if the configured brain is a cloud/CLI one, it still works but shows an honest
   "this one leaves your machine" note.
2. **Streaming required in v1.** Token-by-token, like ChatGPT/Claude, with a Stop button.
3. **Search matches full message content** (user + assistant text), not just titles.
   Linear scan at florist scale — no FTS/SQLite.
4. **Storage: per-chat JSONL + a small index**, patterned on `receipts.ts`. No new dep.
5. **Manage UX: a real "Extensions" page** (own nav) with Chat as the first entry:
   enable/disable + remove (remove = disable + delete history). First-party under the
   hood; previews the marketplace.

## Scope

**In v1:**
- **Extensions** nav page: lists Chat (name, florist description, on/off toggle, Remove).
- **Chat** nav page (shown only when the extension is enabled): searchable chat-list
  sidebar (newest first) + conversation view with streaming reply + composer + Stop.
- New / rename / delete chat. Titles auto-derive from the first user message (no extra
  brain call).
- Streaming replies (local + cloud paths). Full-content search. Per-chat persistence.
- Egress receipts honored (local = on-machine `local:true`; cloud = one egress receipt
  per message, `"sent"` before the call).

**Explicitly OUT (YAGNI):** message edit/regenerate, multiple models per chat,
attachments/images, chat export, and *real* downloadable/third-party extensions
(registry, signing, dynamic code loading, the §8 kill-switch). The Extensions page is
first-party-only for now — it becomes the real surface when the boilerplate is extracted.

## Information architecture

Two new first-party nav pages (per the IA rule — own place, well-named, not bolted on):
- **Extensions** — permanent nav item.
- **Chat** — nav item rendered only when `extensions.chat.enabled` is true.

Both are React pages in `apps/desktop/src/renderer/src/pages`, added to the `Shell.tsx`
`Page` union + `NAV` + render branch. Renderer talks ONLY to main via IPC.

## Streaming architecture (4 layers)

The local brain is whole-reply-only today; streaming is added end-to-end. The router
still writes **exactly one** receipt per assistant message (fail-closed preserved).

1. **`llama-child.ts`** — use node-llama-cpp's `session.prompt(text, { onTextChunk })`.
   Emit incremental `{ type: "chunk", id, text }` messages, then the terminal
   `{ type: "result", id, text, tokensIn, tokensOut }`. Add `onTextChunk` to the locally
   typed `ChatSession` surface.
2. **`llama-engine.ts`** — `generate` gains an `onChunk?: (delta: string) => void`;
   forwards `chunk` messages to it; still resolves with the final `LocalGenerateResult`.
   Wire protocol (`FromChild`) gains the `chunk` variant.
3. **Provider / Router** (`packages/core`) — add a streaming path to the `Provider`
   contract, e.g. `generateStream(input, onDelta): Promise<GenerateResult>` (or `generate`
   gaining an optional `onDelta`). Local wires llama chunks; cloud (OpenRouter/Anthropic)
   uses the Vercel AI SDK `streamText`. The router writes the `"sent"` receipt before the
   call and the `"done"` receipt when the stream completes — one receipt per message.
   Token counts come from the final result (local: llama tokenizer; cloud: SDK usage).
4. **IPC** — `chat:send({ chatId, text })` starts generation. Tokens stream to the
   renderer on a one-way `chat:token` channel `{ chatId, messageId, delta }` (patterned on
   `plugin:progress`, validated at the trust boundary). A terminal `chat:done`/error event
   marks completion. `chat:stop({ chatId })` aborts the in-flight generation (kills the
   llama child's current request / aborts the cloud stream) and finalizes the partial
   assistant message on disk.

**Abort semantics:** on stop, the assistant message is saved with whatever streamed so
far; the receipt is still written `"done"` (the bytes that left are recorded).

## Storage model (main-owned, patterned on `receipts.ts`)

- `userData/chats/index.json` — `ChatMeta[] = { id, title, createdAt, updatedAt }[]`,
  newest-first for the sidebar. Rewritten on create/rename/delete/first-reply (small).
- `userData/chats/<id>.jsonl` — one line per message
  `ChatMessage = { role: "user" | "assistant", content: string, ts: string }`,
  append-only. The assistant line is written when its stream ends (or on stop, partial).
- `id` is a safe slug/uuid; the path sink re-validates charset (mirror `download.ts`
  `modelPath` — no traversal), since `id` becomes a filename.
- **Search** (`chat:search(query)`): scan `index.json` + each chat's `.jsonl` for a
  case-insensitive substring match in title or any message content; return matching
  `ChatMeta` + a snippet. `ponytail:` linear scan is fine at florist volume; add a derived
  index only if it ever measures slow.
- Single-writer discipline: appends go through main only (renderer never touches disk);
  reuse the `receipts.ts` serialize-queue pattern if concurrent writes are possible.

**IPC surface** (all `registerTrusted`, renderer via preload `window.skovern.chat`):
`chat:list()`, `chat:get(id)`, `chat:new()`, `chat:rename(id, title)`, `chat:delete(id)`,
`chat:send({chatId, text})` (streams), `chat:stop({chatId})`, `chat:search(query)`.

## Extension enable/disable/remove

- `userData/extensions.json` — `{ chat: { enabled: boolean } }` (default: enabled? — see
  open question below). Main-owned; IPC `extensions:list()`, `extensions:setEnabled(id,
  bool)`, `extensions:remove(id)`.
- Nav renders Chat only when `chat.enabled`.
- **Remove** = set `enabled: false` AND delete `userData/chats/` (history gone). A florist
  confirm ("This deletes your chats. Sure?").

## Privacy / receipts

- **Local brain**: on-machine — a `local:true` "stayed on your computer" receipt per
  assistant message; no egress. Matches today's `localProvider`.
- **Cloud/CLI brain**: one egress receipt per assistant message (`"sent"` before the byte
  leaves), plus an honest in-chat note that this brain leaves the machine.
- Nothing new bypasses the receipt path — chat routes through the same `Router` + sinks.

## Testing

- **Streaming unit** (core): a fake streaming provider emits deltas → `generateStream`
  forwards them in order and resolves with the assembled text + one receipt (`"sent"`
  then `"done"`). Stop mid-stream → partial text + `"done"` receipt.
- **llama-engine unit** (desktop): a fake child emitting `chunk`+`result` → engine forwards
  deltas and resolves the final result.
- **Storage unit** (desktop): new/append/get/rename/delete round-trip; search finds a
  substring across message content; a traversing `id` is refused at the path sink.
- **Extensions unit**: enable/disable/remove state transitions; remove deletes `chats/`.
- **App e2e** (Playwright, real Electron + real server): enable Chat in Extensions → new
  chat → send a message → a streamed reply renders token-by-token (fake streaming brain via
  an extended `SKOVERN_LLAMA_FAKE` or a fake streaming provider seam) → reload persists the
  chat → search finds it by content → Stop cancels a generation → disable hides Chat from
  nav → Remove clears history. All environment inputs fixtured through `!app.isPackaged`
  seams (determinism gate).

## Loop decomposition

Bigger than one loop; each is its own SPEC→BUILD→VERIFY→SECURE contract:

- **Loop A — streaming infrastructure.** The 4-layer streaming path (llama-child → engine
  → Provider/Router → IPC) + stop + one-receipt-per-message semantics. Proven with a fake
  streaming provider (unit) + the llama-child fake (chunked). Metric is CI-deterministic;
  the real streamed local inference is hand-validation. Foundational — no chat UI yet, but
  it names Loop B as its surfacing follow-up (headless-infra exception to the full-stack
  rule).
- **Loop B — chat feature.** Chat storage + Chat page + streaming wired in + new/rename/
  delete, with an app-e2e (enable → new chat → streamed reply → history persists). Depends
  on A.
- **Loop C — search + Extensions page.** Full-content search UI + the Extensions page
  (enable/disable/remove) + nav gating, app-e2e. Depends on B.

(Loops B and C could merge if they stay small; keep A separate — it's the risky
infra.)

## Prerequisites / gates

- **Debt cap (3 OWED)** must clear before Loop A starts: 029 fresh-VM install, 027 CSV
  export, DESIGN-PASS back-button. (Procedural; mostly Dawid's hand-validation.)
- Loop 030 (GH Actions release matrix) is queued but is NOT a prerequisite for chat.

## Ledger touchpoints (for the loop contracts' triage)

- `llama-native-packaging` — streaming adds new `llama-child` IPC message types; the
  packaged-build proof (029) must still hold. Not a new item; a re-check.
- No new untrusted-plugin surface (chat is first-party, in-process, uses the existing
  router + sinks) — the "before community plugins" cluster is NOT triggered.
- A new `chat-id-path-traversal` guard is required (id → filename) — mirror `download.ts`;
  fold into Loop B, not deferred.

## Open questions (resolve at Loop-A/B SPEC, not blocking this design)

1. **Default enabled?** Ship Chat enabled by default (it's the flagship), or disabled so
   the user "turns it on" (dogfoods the extension flow)? Leaning **enabled by default**;
   the Extensions page still lets them turn it off/remove.
2. **Streaming Provider contract shape** — a separate `generateStream` method vs `generate`
   gaining an optional `onDelta`. Decide at Loop A BUILD; the metric asserts the *outcome*
   (deltas arrive in order, one receipt), not the method shape (mechanism gate).
