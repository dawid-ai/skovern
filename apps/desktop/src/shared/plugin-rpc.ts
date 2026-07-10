// The host ↔ sandboxed-child message protocol. The child holds no powers: every
// capability call is a message the HOST authorizes (via the 012a broker) and
// performs. The host correlates run/probe replies by its OWN `runId` (never an id
// the child echoes), so a compromised child can't spoof a result for another call.

export type HostToChild =
  | { type: "run"; runId: number; pluginId: string; input: string }
  | { type: "cap-result"; reqId: number; ok: boolean; result?: string; error?: string }
  | { type: "sandbox-probe"; runId: number; outsidePath: string };

export type ChildToHost =
  | { type: "ready" }
  | { type: "result"; runId: number; ok: boolean; output?: string; error?: string }
  | { type: "cap"; reqId: number; capability: string; arg: string }
  | { type: "sandbox-result"; runId: number; fsReadDenied: boolean; spawnDenied: boolean; detail?: string };
