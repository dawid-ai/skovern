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
}
