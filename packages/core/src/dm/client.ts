// UI → core → here. The renderer passes only the message string; the session
// bearer token is supplied by the main process (from the OS keychain) and never
// crosses into the renderer.

export type Sender = "user" | "founder";

export interface ThreadMessage {
  sender: Sender;
  body: string;
  createdAt: string;
}

export interface Thread {
  messages: ThreadMessage[];
  /** Founder replies the user hasn't seen yet. */
  unread: number;
}

export interface DmResult {
  ok: boolean;
  /** Warm, florist-facing message from the server (or a fallback). */
  message: string;
}

export interface DmClient {
  send(sessionToken: string, message: string): Promise<DmResult>;
  thread(sessionToken: string): Promise<Thread>;
  markRead(sessionToken: string): Promise<void>;
}

function auth(sessionToken: string): Record<string, string> {
  return { authorization: `Bearer ${sessionToken}` };
}

function isMessage(x: unknown): x is ThreadMessage {
  const m = x as Record<string, unknown>;
  return (
    (m?.["sender"] === "user" || m?.["sender"] === "founder") &&
    typeof m?.["body"] === "string" &&
    typeof m?.["createdAt"] === "string"
  );
}

export function createDmClient(apiBase: string): DmClient {
  return {
    async send(sessionToken: string, message: string): Promise<DmResult> {
      const res = await fetch(`${apiBase}/dm`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth(sessionToken) },
        body: JSON.stringify({ message }),
      });
      const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
      const msg =
        typeof body?.message === "string"
          ? body.message
          : res.ok
            ? "Got it — Dawid will see this."
            : "Couldn't send that. Try again in a moment.";
      return { ok: res.ok, message: msg };
    },

    async thread(sessionToken: string): Promise<Thread> {
      const res = await fetch(`${apiBase}/dm/thread`, { headers: auth(sessionToken) });
      if (!res.ok) return { messages: [], unread: 0 };
      const body = (await res.json().catch(() => null)) as
        | { messages?: unknown; unread?: unknown }
        | null;
      const messages = Array.isArray(body?.messages) ? body.messages.filter(isMessage) : [];
      const unread = typeof body?.unread === "number" ? body.unread : 0;
      return { messages, unread };
    },

    async markRead(sessionToken: string): Promise<void> {
      await fetch(`${apiBase}/dm/read`, { method: "POST", headers: auth(sessionToken) });
    },
  };
}
