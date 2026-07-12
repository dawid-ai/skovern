import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { createRouter, type Provider } from "@deskhand/core";
import { claudeCliProvider, collectOutput } from "./claude-cli.js";

// A fake `claude` we can spawn shell-free on any OS: a node script the provider runs
// via `bin=node, baseArgs=[stub]`. It captures its argv + stdin and prints a canned
// reply, so we can prove the prompt reaches the CLI on stdin (never argv/shell).
const STUB = `
import { writeFileSync } from "node:fs";
const mode = process.env.STUB_MODE ?? "echo";
if (mode === "sleep") { setTimeout(() => {}, 60000); }
else {
  let data = "";
  process.stdin.on("data", (d) => (data += d));
  process.stdin.on("end", () => {
    if (process.env.STUB_CAPTURE) writeFileSync(process.env.STUB_CAPTURE, JSON.stringify({ argv: process.argv.slice(2), stdin: data }));
    if (mode === "empty") process.exit(0);
    if (mode === "fail") { process.stderr.write("stub failure detail"); process.exit(3); }
    process.stdout.write(process.env.STUB_REPLY ?? "STUB_REPLY");
    process.exit(0);
  });
}
`;

let dir: string;
let stub: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "claude-cli-test-"));
  stub = path.join(dir, "stub.mjs");
  writeFileSync(stub, STUB);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A provider that spawns the node stub instead of the real `claude`. */
function stubProvider(model?: string) {
  return claudeCliProvider({ bin: process.execPath, baseArgs: [stub], model, timeoutMs: 5000 });
}

describe("claude-cli provider — shell-free, prompt on stdin (S1)", () => {
  it("sends the prompt on STDIN, never argv, and runs no shell", async () => {
    const capture = path.join(dir, "capture.json");
    const sentinel = path.join(dir, "pwned");
    process.env.STUB_MODE = "echo";
    process.env.STUB_CAPTURE = capture;
    // A prompt full of shell metacharacters. On stdin + no shell → completely inert.
    const prompt = `hello $(touch ${sentinel}) ; echo pwned > ${sentinel} \`whoami\``;
    const reply = await stubProvider().generate(prompt);

    const seen = JSON.parse(readFileSync(capture, "utf8")) as { argv: string[]; stdin: string };
    expect(seen.stdin).toBe(prompt); // arrived verbatim on stdin
    expect(seen.argv).toEqual(["-p"]); // the prompt is NOT in argv
    expect(existsSync(sentinel)).toBe(false); // no shell ran the injected command
    expect(reply).toBe("STUB_REPLY");
    delete process.env.STUB_CAPTURE;
  });

  it("passes --model as a separate arg when set (still no shell)", async () => {
    const capture = path.join(dir, "capture-model.json");
    process.env.STUB_MODE = "echo";
    process.env.STUB_CAPTURE = capture;
    await stubProvider("claude-sonnet-5").generate("hi");
    const seen = JSON.parse(readFileSync(capture, "utf8")) as { argv: string[] };
    expect(seen.argv).toEqual(["-p", "--model", "claude-sonnet-5"]);
    delete process.env.STUB_CAPTURE;
  });
});

describe("claude-cli provider — output + failure handling", () => {
  it("returns stdout as the answer", async () => {
    process.env.STUB_MODE = "echo";
    process.env.STUB_REPLY = "the brain says hi";
    expect(await stubProvider().generate("hi")).toBe("the brain says hi");
    delete process.env.STUB_REPLY;
  });

  it("throws (not silent '') on empty output", async () => {
    process.env.STUB_MODE = "empty";
    await expect(stubProvider().generate("hi")).rejects.toThrow(/returned nothing/);
    process.env.STUB_MODE = "echo";
  });

  it("throws on a non-zero exit", async () => {
    process.env.STUB_MODE = "fail";
    await expect(stubProvider().generate("hi")).rejects.toThrow(/exited 3/);
    process.env.STUB_MODE = "echo";
  });

  it("fails honestly when the CLI is missing (ENOENT), not a hang", async () => {
    const missing = claudeCliProvider({ bin: path.join(dir, "does-not-exist-claude"), timeoutMs: 5000 });
    await expect(missing.generate("hi")).rejects.toThrow(/ENOENT|spawn/);
  });

  it("kills and rejects a hung CLI at the timeout", async () => {
    process.env.STUB_MODE = "sleep";
    const slow = claudeCliProvider({ bin: process.execPath, baseArgs: [stub], timeoutMs: 300 });
    await expect(slow.generate("hi")).rejects.toThrow(/timed out/);
    process.env.STUB_MODE = "echo";
  });
});

// collectOutput must turn EVERY failure into a rejection — an unhandled stream
// 'error' would otherwise crash the host (Electron main → whole app, exit 1). This
// was the real crash: a `claude` dying mid-pipe under rapid sequential calls.
function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void } {
  const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => {};
  return c;
}

describe("collectOutput — no failure mode can crash the host (the crash fix)", () => {
  it("rejects (never throws uncaught) when the stdout stream errors", async () => {
    const c = fakeChild();
    const p = collectOutput(c as unknown as ChildProcess, 5000);
    c.stdout.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    await expect(p).rejects.toThrow(/ECONNRESET/);
  });

  it("rejects when the stderr stream errors", async () => {
    const c = fakeChild();
    const p = collectOutput(c as unknown as ChildProcess, 5000);
    c.stderr.emit("error", new Error("stderr broke"));
    await expect(p).rejects.toThrow(/stderr broke/);
  });

  it("rejects with the exit detail on abnormal termination (e.g. a rate-limited CLI)", async () => {
    const c = fakeChild();
    const p = collectOutput(c as unknown as ChildProcess, 5000);
    c.stderr.emit("data", Buffer.from("rate limited"));
    c.emit("close", null); // killed / abnormal exit → code null
    await expect(p).rejects.toThrow(/exited abnormally.*rate limited/s);
  });

  it("resolves with stdout on a clean close", async () => {
    const c = fakeChild();
    const p = collectOutput(c as unknown as ChildProcess, 5000);
    c.stdout.emit("data", Buffer.from("the answer"));
    c.emit("close", 0);
    await expect(p).resolves.toBe("the answer");
  });
});

describe("egress receipts through the router (S2)", () => {
  it("tags the receipt provider 'claude-cli'", async () => {
    const receipts: { provider: string; phase: string }[] = [];
    process.env.STUB_MODE = "echo";
    process.env.STUB_REPLY = "hi";
    const router = createRouter({
      providers: { "claude-cli": stubProvider() },
      defaultProvider: "claude-cli",
      sink: { append: (r) => void receipts.push(r) },
    });
    await router.generate({ task: "Test my brain", prompt: "hello" });
    expect(receipts.map((r) => r.provider)).toEqual(["claude-cli", "claude-cli"]);
    expect(receipts[0]!.phase).toBe("sent"); // recorded before egress
    delete process.env.STUB_REPLY;
  });

  it("is fail-closed: no spawn if the pre-egress receipt can't be written", async () => {
    const spawned = vi.fn(() => Promise.resolve("leaked"));
    const spy: Provider = { id: "claude-cli", model: "claude-code", generate: spawned };
    const router = createRouter({
      providers: { "claude-cli": spy },
      defaultProvider: "claude-cli",
      sink: { append: () => { throw new Error("disk full"); } },
    });
    await expect(router.generate({ task: "t", prompt: "p" })).rejects.toThrow(/disk full/);
    expect(spawned).not.toHaveBeenCalled();
  });
});

// keys.ts touches Electron — mock it so we can test the keyless round-trip + model
// validation without a real keychain. safeStorage is a passthrough here (no real
// crypto needed for the shape checks).
vi.mock("electron", () => {
  const store = mkdtempSync(path.join(tmpdir(), "claude-cli-keys-"));
  return {
    app: { getPath: () => store },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(s, "utf8"),
      decryptString: (b: Buffer) => b.toString("utf8"),
    },
  };
});

describe("key store — claude-cli has no key + model validation (loadbrain-model-validation)", () => {
  it("round-trips a keyless claude-cli brain", async () => {
    const { saveBrain, loadBrain, brainStatus, clearBrain } = await import("./keys.js");
    clearBrain();
    saveBrain({ provider: "claude-cli", key: "" });
    expect(loadBrain()).toEqual({ provider: "claude-cli", key: "" });
    // brainStatus never leaks a key — and there isn't one here anyway
    expect(brainStatus()).toEqual({ configured: true, provider: "claude-cli", model: null });
  });

  it("accepts a claude-cli config with a valid string model (positive control)", async () => {
    const { saveBrain, loadBrain, clearBrain } = await import("./keys.js");
    clearBrain();
    saveBrain({ provider: "claude-cli", key: "", model: "claude-sonnet-5" });
    expect(loadBrain()).toEqual({ provider: "claude-cli", key: "", model: "claude-sonnet-5" });
  });

  it("rejects a persisted config whose model is not a string", async () => {
    const { loadBrain } = await import("./keys.js");
    const { app, safeStorage } = await import("electron");
    // hand-craft a corrupt config on disk (a non-string model)
    const file = path.join((app as unknown as { getPath: () => string }).getPath(), "brain.bin");
    const bad = JSON.stringify({ provider: "claude-cli", key: "", model: 123 });
    writeFileSync(file, (safeStorage as unknown as { encryptString: (s: string) => Buffer }).encryptString(bad));
    expect(loadBrain()).toBeNull(); // not trusted
  });
});
