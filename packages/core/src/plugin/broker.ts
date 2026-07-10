import type {
  Capability,
  CapabilityRequest,
  CapabilityResponse,
  PluginManifest,
} from "@deskhand/plugin-sdk";
import type { Router } from "../router/types.js";
import type { FetchReceipt, FetchSink } from "./receipt.js";

// The permission broker: the host-side AUTHORITY over what a skill may do. The
// sandboxed child holds no powers — it sends a CapabilityRequest for each call,
// and the broker decides. A capability not in the manifest is denied, even if
// the child forged the message. This is where "no power without a declaration"
// is actually enforced (the manifest the user approved == what runs).

export interface BrokerDeps {
  manifest: PluginManifest;
  /** `brain` capability → the loop-011 router (which already receipts model egress). */
  brain: Router;
  /** `fetch` capability → an https-guarded fetch impl (desktop provides the real one). */
  fetchUrl: (url: string) => Promise<string>;
  /** `fetch` egress receipts — written to the same log as model receipts. */
  fetchSink: FetchSink;
  now?: () => Date;
}

export interface Broker {
  readonly granted: readonly Capability[];
  handle(req: CapabilityRequest): Promise<CapabilityResponse>;
}

function bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function deny(id: number, error: string): CapabilityResponse {
  return { id, ok: false, error };
}

export function createBroker(deps: BrokerDeps): Broker {
  const { manifest, brain, fetchUrl, fetchSink } = deps;
  const clock = deps.now ?? (() => new Date());
  const granted = manifest.capabilities;

  async function handleFetch(req: CapabilityRequest): Promise<CapabilityResponse> {
    let host: string;
    try {
      const u = new URL(req.arg);
      const loopback =
        u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
      if (u.protocol !== "https:" && !loopback) {
        return deny(req.id, "That skill tried to use an unsafe web address.");
      }
      host = u.host;
    } catch {
      return deny(req.id, "That skill tried to read an invalid web address.");
    }

    const base = { kind: "fetch" as const, host, task: `skill:${manifest.id} fetch`, bytesSent: bytes(req.arg) };
    // Record the egress BEFORE it happens. Awaited and NOT swallowed: if it
    // throws, we never fetch — no byte leaves without a durable receipt.
    await fetchSink.append({ ...base, ts: clock().toISOString(), bytesReceived: 0, ok: false, phase: "sent" });

    let body: string | null = null;
    let failed = false;
    try {
      body = await fetchUrl(req.arg);
    } catch {
      failed = true;
    }

    const done: FetchReceipt = {
      ...base,
      ts: clock().toISOString(),
      bytesReceived: bytes(body ?? ""),
      ok: !failed,
      phase: "done",
    };
    try {
      await fetchSink.append(done);
    } catch {
      // egress already receipted by the "sent" line
    }

    if (failed || body === null) return deny(req.id, "Couldn't read that page.");
    return { id: req.id, ok: true, result: body };
  }

  return {
    granted,
    async handle(req: CapabilityRequest): Promise<CapabilityResponse> {
      // Treat the whole request as untrusted (it crossed a process boundary).
      if (typeof req.arg !== "string") return deny(req.id, "That skill sent something we couldn't read.");
      if (!granted.includes(req.capability)) {
        return deny(req.id, "That skill didn't ask for permission to do that.");
      }

      if (req.capability === "brain") {
        try {
          const { text } = await brain.generate({ task: `skill:${manifest.id}`, prompt: req.arg });
          return { id: req.id, ok: true, result: text };
        } catch {
          return deny(req.id, "The brain couldn't answer just now.");
        }
      }

      return handleFetch(req);
    },
  };
}
