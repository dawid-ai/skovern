import { describe, expect, it, vi } from "vitest";
import type { FetchReceipt, LocalEngine, PullProgress } from "@skovern/core";

vi.mock("electron", () => ({ app: { getPath: () => "", isPackaged: false } }));
const dist = vi.hoisted(() => ({ value: { version: "1", url: "https://github.com/x.zip", sha256: "a", sizeBytes: 1_000, filename: "x.zip" } as unknown }));
vi.mock("./ollama-dist.js", () => ({ ollamaDist: () => dist.value, installManagedOllama: vi.fn() }));

import { plainPullMessage, receiptedOllamaPull, setUpAndGet, type SetupDeps } from "./ollama-setup.js";

const GB = 1024 ** 3;

function engine(pull: LocalEngine["pull"]): LocalEngine {
  return { pull } as unknown as LocalEngine;
}

describe("receiptedOllamaPull (047: a brain Ollama downloads is receipted too)", () => {
  it("writes 'sent' BEFORE /api/pull is called, then 'done' with the bytes Ollama reported", async () => {
    const log: string[] = [];
    const receipts: FetchReceipt[] = [];
    const sink = { append: (r: FetchReceipt) => void (receipts.push(r), log.push(`receipt:${r.phase}`)) };
    const pull = vi.fn(async (_id: string, on?: (p: PullProgress) => void) => {
      log.push("pull");
      on?.({ status: "pulling aaa", completed: 500, total: 1000 });
      on?.({ status: "pulling aaa", completed: 1000, total: 1000 });
      on?.({ status: "pulling bbb", completed: 20, total: 20 });
    });
    await receiptedOllamaPull(engine(pull), "qwen2.5:32b", () => {}, sink);
    expect(log).toEqual(["receipt:sent", "pull", "receipt:done"]);
    expect(receipts[0]).toMatchObject({ host: "registry.ollama.ai", direction: "in", ok: false, phase: "sent" });
    expect(receipts[1]).toMatchObject({ ok: true, phase: "done", bytesReceived: 1020 });
  });

  it("if the 'sent' receipt can't be written, nothing is pulled", async () => {
    const pull = vi.fn(async () => {});
    const sink = { append: () => Promise.reject(new Error("disk")) };
    await expect(receiptedOllamaPull(engine(pull), "m", () => {}, sink)).rejects.toThrow("disk");
    expect(pull).not.toHaveBeenCalled();
  });

  it("M4(d): a failed pull comes back in plain words with a not-ok 'done' receipt", async () => {
    const receipts: FetchReceipt[] = [];
    const pull = async () => {
      throw new Error("Ollama couldn't get that model: read tcp 127.0.0.1:5123->1.2.3.4:443: wsarecv: An existing connection was forcibly closed");
    };
    await expect(receiptedOllamaPull(engine(pull), "m", () => {}, { append: (r) => void receipts.push(r) })).rejects.toThrow(
      "The brain download stopped. Try again — it picks up where it left off.",
    );
    expect(receipts.map((r) => [r.phase, r.ok])).toEqual([["sent", false], ["done", false]]);
  });
});

describe("plainPullMessage (closes ollama-pull-raw-error-text)", () => {
  it.each([
    ["Ollama couldn't get that model: pull model manifest: file does not exist", "We couldn't find that brain. Check its name and try again."],
    ["Ollama couldn't get that model: write /x: no space left on device", "There isn't enough free space on this computer for this brain. Free up some room and try again."],
    ["TypeError: terminated", "The brain download stopped. Try again — it picks up where it left off."],
    ["Ollama isn't running on this computer — start it and try again. (fetch failed: ECONNREFUSED)", "Ollama isn't running on this computer — start it and try again."],
  ])("%j → %j", (raw, plain) => {
    expect(plainPullMessage(new Error(raw))).toBe(plain);
  });

  it("our own plain messages pass through unchanged", () => {
    const own = "Ollama couldn't start the download (404). Check the model name.";
    expect(plainPullMessage(new Error(own))).toBe(own);
  });

  it("no raw developer words ever reach the user", () => {
    for (const raw of ["ECONNRESET", "socket hang up", "Ollama couldn't get that model: EOF", "undici: terminated"]) {
      expect(plainPullMessage(new Error(raw))).not.toMatch(/ECONN|socket|EOF|undici|terminated/);
    }
  });
});

function deps(over: Partial<SetupDeps> = {}): SetupDeps & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    installed: () => false,
    install: vi.fn(async (_s, on) => {
      log.push("install");
      on?.({ completed: 500, total: 1000, percent: 50 });
      on?.({ completed: 1000, total: 1000, percent: 100 });
      return "/x/ollama.exe";
    }) as unknown as SetupDeps["install"],
    start: async () => (log.push("start"), true),
    allowAutoStart: () => void log.push("allowAutoStart"),
    pull: async (_id, on) => {
      log.push("pull");
      on({ status: "pulling", percent: 40 });
    },
    sink: { append: () => {} },
    probeFreeBytes: async () => 1000 * GB,
    ...over,
  };
}

describe("setUpAndGet (047: one flow after the consent)", () => {
  it("no Ollama here: helper → set up → start → brain, in that order", async () => {
    const d = deps();
    const phases: string[] = [];
    await setUpAndGet("qwen2.5:32b", 20 * GB, (t) => phases.push(t.phase), d);
    expect(d.log).toEqual(["install", "allowAutoStart", "start", "pull"]);
    expect([...new Set(phases)]).toEqual(["helper", "unpack", "start", "brain"]);
  });

  it("Ollama already here (the user's own, or set up before): no helper download", async () => {
    const d = deps({ installed: () => true });
    await setUpAndGet("qwen2.5:32b", 20 * GB, () => {}, d);
    expect(d.log).toEqual(["allowAutoStart", "start", "pull"]);
  });

  it("M4(e): not enough room for helper + brain → refused before anything downloads", async () => {
    const d = deps({ probeFreeBytes: async () => 5 * GB });
    await expect(setUpAndGet("qwen2.5:32b", 20 * GB, () => {}, d)).rejects.toThrow(
      "There isn't enough free space on this computer for this brain and its helper. Free up some room and try again.",
    );
    expect(d.log).toEqual([]);
  });

  it("M4(c): the helper won't start → plain message, no brain download", async () => {
    const d = deps({ start: async () => false });
    await expect(setUpAndGet("qwen2.5:32b", 20 * GB, () => {}, d)).rejects.toThrow(/didn't start/);
    expect(d.log).not.toContain("pull");
  });

  it("no helper build for this computer and no Ollama → refused, nothing downloads", async () => {
    const saved = dist.value;
    dist.value = null;
    const d = deps();
    await expect(setUpAndGet("m", GB, () => {}, d)).rejects.toThrow(/can't set up the helper/);
    expect(d.log).toEqual([]);
    dist.value = saved;
  });
});
