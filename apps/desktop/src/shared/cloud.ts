// Shapes crossing the renderer ↔ main IPC boundary for news + DM. UI-facing:
// plain data, warm messages, never tokens or raw errors.

export interface NewsPostView {
  slug: string;
  title: string;
  body: string;
  publishedAt: string;
}

export interface DmSendResult {
  ok: boolean;
  message: string;
}

export type Sender = "user" | "founder";

export interface ThreadMessageView {
  sender: Sender;
  body: string;
  createdAt: string;
}

export interface DmThreadView {
  messages: ThreadMessageView[];
  /** Founder replies the user hasn't seen yet — drives the nav badge. */
  unread: number;
}

export interface PublishVisibilityInput {
  business: string;
  score: number;
  competitors: string[];
}

export interface PublishResultView {
  ok: boolean;
  /** The public URL, on success. */
  url?: string;
  message: string;
}
