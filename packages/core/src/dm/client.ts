// UI → core → here. The renderer passes only the message string; the session
// bearer token is supplied by the main process (from the OS keychain) and never
// crosses into the renderer.

export interface DmResult {
  ok: boolean;
  /** Warm, florist-facing message from the server (or a fallback). */
  message: string;
}

export interface DmClient {
  send(sessionToken: string, message: string): Promise<DmResult>;
}

export function createDmClient(apiBase: string): DmClient {
  return {
    async send(sessionToken: string, message: string): Promise<DmResult> {
      const res = await fetch(`${apiBase}/dm`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
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
  };
}
