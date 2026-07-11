// The only network path for accounts. Per the architecture rule, the UI never
// talks to the cloud API directly — it goes UI → core → here. No Electron
// imports, so this stays unit-testable and ready to move to a separate process.

export interface Session {
  /** Opaque bearer token issued by the server. */
  token: string;
  ogNumber: number;
}

export interface AccountClient {
  requestMagicLink(email: string): Promise<void>;
  verifyMagicLink(token: string): Promise<Session | null>;
}

async function postJson(
  fetchImpl: typeof fetch,
  base: string,
  path: string,
  payload: unknown,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await fetchImpl(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

// `fetchImpl` defaults to global `fetch`; the desktop main process injects a
// receipted wrapper so every first-party call lands in the egress log. Not
// injecting keeps behavior (and these tests) unchanged.
export function createAccountClient(apiBase: string, fetchImpl: typeof fetch = fetch): AccountClient {
  return {
    async requestMagicLink(email: string): Promise<void> {
      // The server always answers 200 here (no account enumeration); a non-ok
      // means the server is unreachable/broken, which the caller surfaces.
      await postJson(fetchImpl, apiBase, "/auth/request", { email });
    },

    async verifyMagicLink(token: string): Promise<Session | null> {
      const res = await postJson(fetchImpl, apiBase, "/auth/verify", { token });
      if (!res.ok) return null;
      const body = res.body as { session?: unknown; ogNumber?: unknown };
      if (typeof body.session !== "string" || typeof body.ogNumber !== "number") {
        return null;
      }
      return { token: body.session, ogNumber: body.ogNumber };
    },
  };
}
