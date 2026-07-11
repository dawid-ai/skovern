// UI → core → here. The renderer passes only the result to publish; the session
// bearer token is supplied by the main process (never in the renderer). Publishing
// is an OUTBOUND action, so it always carries an authenticated owner's session.

export interface VisibilityToPublish {
  business: string;
  score: number;
  competitors: string[];
}

export interface PublishResult {
  ok: boolean;
  /** The public URL, on success. */
  url?: string;
  /** Warm, florist-facing message (or a fallback). */
  message: string;
}

export interface PublishClient {
  publishVisibility(sessionToken: string, result: VisibilityToPublish): Promise<PublishResult>;
}

export function createPublishClient(apiBase: string): PublishClient {
  return {
    async publishVisibility(sessionToken: string, result: VisibilityToPublish): Promise<PublishResult> {
      const res = await fetch(`${apiBase}/publish/visibility`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify(result),
      });
      const body = (await res.json().catch(() => null)) as { url?: unknown; message?: unknown } | null;
      const url = typeof body?.url === "string" ? body.url : undefined;
      const message =
        typeof body?.message === "string"
          ? body.message
          : res.ok
            ? "Published!"
            : "Couldn't publish that. Try again in a moment.";
      return { ok: res.ok && !!url, url, message };
    },
  };
}
