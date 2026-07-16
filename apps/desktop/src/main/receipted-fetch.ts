import type { FetchSink } from "@skovern/core";

// Wrap `fetch` so every first-party cloud call is receipted like a plugin fetch:
// a `"sent"` line lands on disk BEFORE any byte leaves (fail-closed — if the sink
// throws we never fetch), then a `"done"` line with the outcome. Metadata only:
// host (never the full URL / query string), a caller-supplied label, and byte
// counts — never a key, header, or body. One wrapper is built per client with its
// own label ("Skovern: news", etc.). Split from the log store (receipts.ts): this is
// the egress-wrapper concern; that file owns the on-disk log + its activity index.

function encodedBytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host; // host only — the path/query (where secrets hide) is dropped
  } catch {
    return "unknown";
  }
}

function bodyBytes(init: Parameters<typeof fetch>[1]): number {
  const body = init?.body;
  // The cloud clients send JSON strings; measure those, ignore other body shapes.
  return typeof body === "string" ? encodedBytes(body) : 0;
}

// `routine:true` marks the app's own timer polls (news/messages/model list) so the
// panel groups them at the source, not by sniffing the label. Default false — a
// caller must opt a client in explicitly, so no meaningful egress is ever grouped.
// `direction` (in/out) is likewise stamped here at the call site, never inferred.
export function receiptedFetch(
  sink: FetchSink,
  label: string,
  opts?: { routine?: boolean; direction?: "in" | "out" },
): typeof fetch {
  const routine = opts?.routine === true;
  const direction = opts?.direction;
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const base = {
      kind: "fetch" as const,
      host: hostOf(requestUrl(input)),
      task: label,
      bytesSent: bodyBytes(init),
      ...(routine ? { routine: true } : {}),
      ...(direction ? { direction } : {}),
    };
    // Fail-closed: the "sent" receipt must be durable before egress. Awaited and
    // NOT swallowed — if it throws, we never fetch, so no byte leaves unrecorded.
    await sink.append({ ...base, ts: new Date().toISOString(), bytesReceived: 0, ok: false, phase: "sent" });

    let res: Response;
    try {
      res = await fetch(input, init);
    } catch (err) {
      try {
        await sink.append({ ...base, ts: new Date().toISOString(), bytesReceived: 0, ok: false, phase: "done" });
      } catch {
        // egress already receipted by the "sent" line
      }
      throw err;
    }

    let bytesReceived = 0;
    try {
      // Clone so the caller still gets an unread body; only the count is kept.
      bytesReceived = (await res.clone().arrayBuffer()).byteLength;
    } catch {
      bytesReceived = 0;
    }
    try {
      await sink.append({ ...base, ts: new Date().toISOString(), bytesReceived, ok: res.ok, phase: "done" });
    } catch {
      // egress already receipted by the "sent" line
    }
    return res;
  };
  // why: our wrapper covers the (input, init) call shape the clients use; the
  // extra static members on `typeof fetch` (e.g. preconnect) are never called.
  return wrapped as typeof fetch;
}
