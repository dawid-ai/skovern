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
