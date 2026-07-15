// Shapes crossing the renderer ↔ main IPC boundary for the Chat page. Plain data,
// warm messages, never a key or the raw brain error.

export type ChatRole = "user" | "assistant";

/** One line in a chat's `<id>.jsonl` (append-only). */
export interface ChatMessage {
  role: ChatRole;
  content: string;
  ts: string;
}

/** The chat-list entry in `index.json` — newest-first by `updatedAt` in the sidebar. */
export interface ChatMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** A whole conversation: its meta + every message. */
export interface ChatView {
  meta: ChatMeta;
  messages: ChatMessage[];
}

/** A streamed token, main → renderer, on the one-way `chat:token` channel. */
export interface ChatTokenEvent {
  chatId: string;
  messageId: string;
  delta: string;
}

/** A prepare/launch status line, main → renderer, on the one-way `chat:status`
 *  channel (loop 033 Issue 4). Florist-language phase ("Starting Ollama…",
 *  "Loading the model…", "Thinking…"); an empty `phase` clears it (the reply is
 *  streaming or the send ended). */
export interface ChatStatusEvent {
  chatId: string;
  phase: string;
}

/** The reply to `chat:send` once generation finishes (or is stopped). */
export interface ChatSendResult {
  ok: boolean;
  /** The assistant message id these tokens belonged to. */
  messageId?: string;
  /** The final (or partial, on stop) assistant text, as saved to disk. */
  text?: string;
  /** Warm, florist-facing note on failure (never the raw brain error). */
  message?: string;
  /** A transparency note on success (e.g. a self-reliant fallback to the built-in brain). */
  note?: string;
  /** True when the send couldn't run for lack of a usable brain and setting one up would
   *  fix it (no brain configured, or the Ollama brain is down with no built-in to fall back
   *  to). The Chat page turns this into an in-chat "Set up a brain" CTA (loop 033 Issue 1/3). */
  offerSetup?: boolean;
}
