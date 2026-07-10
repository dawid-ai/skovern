// Plugin SDK — typed contracts for skills, permission manifests, and the core
// API surface plugins are allowed to touch. MIT: your plugins are yours.
export const SDK_VERSION = "0.0.1";

/** A capability a skill can DECLARE and, once granted, use. The manifest is the
 *  source of truth: the host only exposes — and only allows — what's listed here.
 *  Grows per plugin need (filesystem, schedule, connectors) in later loops. */
export type Capability = "brain" | "fetch";

export const CAPABILITIES: readonly Capability[] = ["brain", "fetch"];

/** What a skill is + what it's allowed to touch. Rendered as a plain-English
 *  permission card on install (see `explainCapability`). */
export interface PluginManifest {
  id: string;
  /** Florist-facing name ("Website Checkup"). */
  name: string;
  /** One warm sentence: what it does. */
  description: string;
  capabilities: Capability[];
}

/** The powers handed to a running skill. A field is present ONLY if the
 *  manifest granted its capability — a skill literally cannot call what it
 *  didn't declare. */
export interface PluginContext {
  /** Use the assistant's brain. Present iff `"brain"` granted. */
  brain?: { generate(prompt: string): Promise<string> };
  /** Read a page from the internet (receipted). Present iff `"fetch"` granted. */
  fetch?: (url: string) => Promise<string>;
}

/** A skill: its manifest + the work it does when run. */
export interface Plugin {
  manifest: PluginManifest;
  run(ctx: PluginContext, input: string): Promise<string>;
}

// --- host ↔ sandboxed child RPC ---------------------------------------------
// The child holds no powers of its own; each capability call is a message the
// host authorizes (against the manifest) and performs. The child cannot escalate
// by forging a capability it didn't declare — the host is the authority.

export interface CapabilityRequest {
  id: number;
  capability: Capability;
  /** The single string argument (a prompt for brain, a url for fetch). */
  arg: string;
}

export interface CapabilityResponse {
  id: number;
  ok: boolean;
  result?: string;
  /** Generic, florist-safe — never carries a key or provider error detail. */
  error?: string;
}

// `Record<Capability, …>` keeps this exhaustive at compile time (a new capability
// without a card fails typecheck), while the `??` gives a safe answer if a JS
// caller passes something outside the union — never a blank permission card.
const CARDS: Record<Capability, string> = {
  brain: "Use your assistant's brain to think.",
  fetch: "Read pages from the internet — you'll see a receipt for each.",
};

/** The exact sentence the user is shown to approve for each capability. What
 *  they see here is what the broker enforces — no drift. */
export function explainCapability(c: Capability): string {
  return CARDS[c] ?? "This skill wants a permission we don't recognize — best not to allow it.";
}
