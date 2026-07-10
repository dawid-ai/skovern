import type { Capability, PluginContext } from "@deskhand/plugin-sdk";
import { helloPlugin } from "../plugins/hello/index.js";
import type { ChildToHost, HostToChild } from "../shared/plugin-rpc.js";

// The sandboxed child. It runs as the shipped Electron binary in ELECTRON_RUN_AS_NODE
// mode under Node's Permission Model (fs-read scoped to its own dir, no subprocess) —
// Electron's utilityProcess silently ignores those flags, so the host forks this via
// child_process instead. The child holds NO powers: `ctx.fetch`/`ctx.brain` are thin
// RPC stubs wired only if the manifest declared that capability; every real decision
// (allow/deny, the fetch, the receipt) happens host-side in the 012a broker.

function send(msg: ChildToHost): void {
  process.send?.(msg);
}

// One plugin for v1; a real registry lands with more skills.
const PLUGINS = new Map([[helloPlugin.manifest.id, helloPlugin]]);

// Child-owned pending map: correlates OUR capability calls to their replies. Purely
// local — a bad reqId only confuses this child, never the host.
let reqCounter = 0;
const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();

function callCap(capability: Capability, arg: string): Promise<string> {
  const reqId = ++reqCounter;
  return new Promise<string>((resolve, reject) => {
    pending.set(reqId, { resolve, reject });
    send({ type: "cap", reqId, capability, arg });
  });
}

function isAccessDenied(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === "ERR_ACCESS_DENIED" || String((err as Error)?.message ?? err).includes("ERR_ACCESS_DENIED");
}

async function probe(runId: number, outsidePath: string): Promise<void> {
  let fsReadDenied = false;
  let spawnDenied = false;
  let fsErr = "no-throw";
  let spawnErr = "no-throw";
  try {
    const fs = await import("node:fs");
    fs.readFileSync(outsidePath, "utf8");
  } catch (err) {
    fsErr = String((err as { code?: string })?.code ?? (err as Error)?.message ?? err);
    fsReadDenied = isAccessDenied(err);
  }
  try {
    const cp = await import("node:child_process");
    const r = cp.spawnSync(process.execPath, ["-e", "0"]);
    if (r.error) spawnErr = String((r.error as { code?: string }).code ?? r.error.message);
    spawnDenied = r.error != null && isAccessDenied(r.error);
  } catch (err) {
    spawnErr = String((err as { code?: string })?.code ?? (err as Error)?.message ?? err);
    spawnDenied = isAccessDenied(err);
  }
  const permission = typeof (process as { permission?: unknown }).permission;
  const detail = `perm=${permission} node=${process.versions.node} fsErr=${fsErr} spawnErr=${spawnErr}`;
  send({ type: "sandbox-result", runId, fsReadDenied, spawnDenied, detail });
}

async function run(runId: number, pluginId: string, input: string): Promise<void> {
  const plugin = PLUGINS.get(pluginId);
  if (!plugin) {
    send({ type: "result", runId, ok: false, error: "unknown skill" });
    return;
  }
  const ctx: PluginContext = {};
  if (plugin.manifest.capabilities.includes("brain")) ctx.brain = { generate: (p) => callCap("brain", p) };
  if (plugin.manifest.capabilities.includes("fetch")) ctx.fetch = (u) => callCap("fetch", u);
  try {
    const output = await plugin.run(ctx, input);
    send({ type: "result", runId, ok: true, output });
  } catch {
    send({ type: "result", runId, ok: false, error: "skill failed" });
  }
}

process.on("message", (msg: HostToChild) => {
  if (msg.type === "cap-result") {
    const p = pending.get(msg.reqId);
    if (!p) return;
    pending.delete(msg.reqId);
    if (msg.ok) p.resolve(msg.result ?? "");
    else p.reject(new Error(msg.error ?? "denied"));
    return;
  }
  if (msg.type === "run") {
    void run(msg.runId, msg.pluginId, msg.input);
    return;
  }
  if (msg.type === "sandbox-probe") {
    void probe(msg.runId, msg.outsidePath);
  }
});

// Announce readiness only after the listener is attached, so the host never posts a
// run/probe into a child that isn't listening yet.
send({ type: "ready" });
