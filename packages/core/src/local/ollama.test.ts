import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ollamaEngine } from "./ollama.js";
import type { PullProgress } from "./types.js";

// O1 — the Ollama backend against a FIXTURE server (no real Ollama in CI): detect,
// listModels, generate, and streamed pull parse correctly, and EVERY failure mode
// becomes a specific, descriptive rejection (lint bans a bare .toThrow()).
// O2 — the loopback-only guard: a non-loopback base URL is refused at construction.

type Handler = (method: string, url: string, body: string) => { status: number; body: string; ndjson?: string[] };

let server: Server | null = null;

function startFixture(handler: Handler): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const out = handler(req.method ?? "", req.url ?? "", Buffer.concat(chunks).toString("utf8"));
        if (out.ndjson) {
          res.writeHead(out.status, { "content-type": "application/x-ndjson" });
          for (const line of out.ndjson) res.write(line + "\n");
          res.end();
          return;
        }
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(out.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(async () => {
  // Destroy any still-open sockets (a deliberately-stalled fixture keeps a
  // connection open) so close() resolves instead of hanging the teardown.
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

// A fixture with direct (req,res) control — for streaming/stalling scenarios the
// canned-response helper can't express. Assigned to `server` so afterEach cleans it.
function startRawServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

describe("ollamaEngine — happy paths (fixture server)", () => {
  it("detects a running Ollama via GET /api/tags", async () => {
    const base = await startFixture((_m, url) =>
      url === "/api/tags" ? { status: 200, body: JSON.stringify({ models: [] }) } : { status: 404, body: "{}" },
    );
    const engine = ollamaEngine({ baseUrl: base });
    expect(await engine.detect()).toBe(true);
  });

  it("lists the user's pulled models with size/quant/params parsed", async () => {
    const base = await startFixture(() => ({
      status: 200,
      body: JSON.stringify({
        models: [
          { name: "qwen2.5:3b", size: 1_900_000_000, details: { quantization_level: "Q4_K_M", parameter_size: "3.1B" } },
          { name: "llama3.2:1b", size: 800_000_000, details: { quantization_level: "Q8_0", parameter_size: "1.2B" } },
        ],
      }),
    }));
    const engine = ollamaEngine({ baseUrl: base });
    const models = await engine.listModels();
    expect(models.map((m) => m.id)).toEqual(["qwen2.5:3b", "llama3.2:1b"]);
    expect(models[0]).toMatchObject({ sizeBytes: 1_900_000_000, quant: "Q4_K_M", params: 3.1 });
  });

  it("generates text from POST /api/generate, with token counts", async () => {
    const base = await startFixture((_m, url) =>
      url === "/api/generate"
        ? { status: 200, body: JSON.stringify({ response: "Hello from a local model.", prompt_eval_count: 11, eval_count: 22 }) }
        : { status: 404, body: "{}" },
    );
    const engine = ollamaEngine({ baseUrl: base });
    const out = await engine.generate("qwen2.5:3b", "hi");
    expect(out.text).toBe("Hello from a local model.");
    expect(out.tokensIn).toBe(11);
    expect(out.tokensOut).toBe(22);
  });

  it("omits token counts when Ollama doesn't report them (undefined, not 0)", async () => {
    const base = await startFixture((_m, url) =>
      url === "/api/generate" ? { status: 200, body: JSON.stringify({ response: "No counts here." }) } : { status: 404, body: "{}" },
    );
    const out = await ollamaEngine({ baseUrl: base }).generate("m", "hi");
    expect(out.text).toBe("No counts here.");
    expect(out.tokensIn).toBeUndefined();
    expect(out.tokensOut).toBeUndefined();
  });

  it("streams pull progress and completes", async () => {
    const base = await startFixture((_m, url) =>
      url === "/api/pull"
        ? {
            status: 200,
            body: "",
            ndjson: [
              JSON.stringify({ status: "pulling manifest" }),
              JSON.stringify({ status: "downloading", completed: 50, total: 100 }),
              JSON.stringify({ status: "downloading", completed: 100, total: 100 }),
              JSON.stringify({ status: "success" }),
            ],
          }
        : { status: 404, body: "{}" },
    );
    const engine = ollamaEngine({ baseUrl: base });
    const ticks: PullProgress[] = [];
    await engine.pull("qwen2.5:3b", (p) => ticks.push(p));
    expect(ticks.map((t) => t.status)).toContain("success");
    expect(ticks.some((t) => t.percent === 50)).toBe(true);
    expect(ticks.some((t) => t.percent === 100)).toBe(true);
  });
});

describe("ollamaEngine — generateStream (NDJSON, Issue 2)", () => {
  it("streams the reply as ordered deltas and returns final token counts", async () => {
    const base = await startFixture((_m, url) =>
      url === "/api/generate"
        ? {
            status: 200,
            body: "",
            // Ollama's stream:true emits one NDJSON object per token, then a final
            // done:true line carrying the usage counts.
            ndjson: [
              JSON.stringify({ response: "Hello", done: false }),
              JSON.stringify({ response: " from", done: false }),
              JSON.stringify({ response: " Ollama.", done: false }),
              JSON.stringify({ response: "", done: true, prompt_eval_count: 7, eval_count: 3 }),
            ],
          }
        : { status: 404, body: "{}" },
    );
    const engine = ollamaEngine({ baseUrl: base });
    const deltas: string[] = [];
    const out = await engine.generateStream!("qwen2.5:3b", "hi", (d) => deltas.push(d));
    // more than one delta = it actually streamed (vs one lump)
    expect(deltas).toEqual(["Hello", " from", " Ollama."]);
    expect(out.text).toBe("Hello from Ollama.");
    expect(out.tokensIn).toBe(7);
    expect(out.tokensOut).toBe(3);
  });

  it("omits token counts when the stream doesn't report them (undefined, not 0)", async () => {
    const base = await startFixture((_m, url) =>
      url === "/api/generate"
        ? { status: 200, body: "", ndjson: [JSON.stringify({ response: "Hi.", done: true })] }
        : { status: 404, body: "{}" },
    );
    const out = await ollamaEngine({ baseUrl: base }).generateStream!("m", "hi", () => {});
    expect(out.text).toBe("Hi.");
    expect(out.tokensIn).toBeUndefined();
    expect(out.tokensOut).toBeUndefined();
  });

  it("captures counts from a single non-streamed object (response + counts, no done flag)", async () => {
    // The core router funnels generate() through generateStream when the engine exposes it,
    // so a non-NDJSON reply (one object with response + prompt_eval_count/eval_count) must
    // still report tokens — otherwise a plain "Test my brain" loses its on-machine token line.
    const base = await startFixture((_m, url) =>
      url === "/api/generate"
        ? { status: 200, body: "", ndjson: [JSON.stringify({ response: "One-shot reply.", prompt_eval_count: 7, eval_count: 42 })] }
        : { status: 404, body: "{}" },
    );
    const deltas: string[] = [];
    const out = await ollamaEngine({ baseUrl: base }).generateStream!("m", "hi", (d) => deltas.push(d));
    expect(out.text).toBe("One-shot reply.");
    expect(out.tokensIn).toBe(7);
    expect(out.tokensOut).toBe(42);
  });

  it("aborts mid-stream and resolves with the partial (no throw)", async () => {
    // A raw server that emits a chunk every ~60ms so we can abort after the first.
    const base = await startRawServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      let i = 0;
      const chunks = ["Alpha", " Beta", " Gamma", " Delta"];
      const tick = (): void => {
        if (i >= chunks.length) {
          res.write(JSON.stringify({ response: "", done: true }) + "\n");
          res.end();
          return;
        }
        res.write(JSON.stringify({ response: chunks[i], done: false }) + "\n");
        i++;
        setTimeout(tick, 60);
      };
      tick();
    });
    const engine = ollamaEngine({ baseUrl: base });
    const controller = new AbortController();
    const deltas: string[] = [];
    const out = await engine.generateStream!(
      "m",
      "hi",
      (d) => {
        deltas.push(d);
        if (deltas.length === 1) controller.abort(); // stop right after the first token
      },
      controller.signal,
    );
    // resolved (not rejected) with the partial captured before the abort
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(out.text).toBe(deltas.join(""));
    expect(out.text.startsWith("Alpha")).toBe(true);
    // it did NOT run to completion (abort really stopped it)
    expect(out.text).not.toContain("Delta");
  });

  it("surfaces an error line during a stream (never a silent empty)", async () => {
    const base = await startFixture((_m, url) =>
      url === "/api/generate"
        ? {
            status: 200,
            body: "",
            ndjson: [JSON.stringify({ response: "part", done: false }), JSON.stringify({ error: "out of memory" })],
          }
        : { status: 404, body: "{}" },
    );
    const engine = ollamaEngine({ baseUrl: base });
    await expect(engine.generateStream!("m", "hi", () => {})).rejects.toThrow(/error.*out of memory/i);
  });

  it("reports Ollama-not-running when the stream can't connect", async () => {
    const engine = ollamaEngine({ baseUrl: "http://127.0.0.1:1" });
    await expect(engine.generateStream!("m", "hi", () => {})).rejects.toThrow(/Ollama isn't running/i);
  });
});

describe("ollamaEngine — descriptive failures", () => {
  it("names Ollama-not-running when the server is unreachable", async () => {
    // A loopback port with nothing listening → connection refused.
    const engine = ollamaEngine({ baseUrl: "http://127.0.0.1:1" });
    await expect(engine.listModels()).rejects.toThrow(/Ollama isn't running/i);
    // detect() is a soft probe: it resolves false, never rejects.
    expect(await engine.detect()).toBe(false);
  });

  it("reports a non-200 status with the code", async () => {
    const base = await startFixture(() => ({ status: 503, body: "busy" }));
    const engine = ollamaEngine({ baseUrl: base });
    await expect(engine.listModels()).rejects.toThrow(/error \(503\)/i);
  });

  it("reports a malformed models body clearly", async () => {
    const base = await startFixture(() => ({ status: 200, body: "not json at all" }));
    const engine = ollamaEngine({ baseUrl: base });
    await expect(engine.listModels()).rejects.toThrow(/couldn't read/i);
  });

  it("reports an empty generate reply clearly", async () => {
    const base = await startFixture(() => ({ status: 200, body: JSON.stringify({ response: "" }) }));
    const engine = ollamaEngine({ baseUrl: base });
    await expect(engine.generate("m", "hi")).rejects.toThrow(/answered with nothing/i);
  });

  it("surfaces an Ollama error line during a pull (bad model name, disk full…)", async () => {
    const base = await startFixture(() => ({
      status: 200,
      body: "",
      ndjson: [JSON.stringify({ status: "pulling manifest" }), JSON.stringify({ error: "model 'nope' not found" })],
    }));
    const engine = ollamaEngine({ baseUrl: base });
    await expect(engine.pull("nope")).rejects.toThrow(/couldn't get that model.*not found/i);
  });
});

describe("ollamaEngine — loopback-only guard (O2)", () => {
  it("refuses a non-loopback base URL at construction", () => {
    expect(() => ollamaEngine({ baseUrl: "http://10.0.0.5:11434" })).toThrow(/only talk to this computer/i);
    expect(() => ollamaEngine({ baseUrl: "http://evil.example.com:11434" })).toThrow(/only talk to this computer/i);
  });

  it("accepts every loopback form", () => {
    expect(() => ollamaEngine({ baseUrl: "http://127.0.0.1:11434" })).not.toThrow();
    expect(() => ollamaEngine({ baseUrl: "http://localhost:11434" })).not.toThrow();
    expect(() => ollamaEngine({ baseUrl: "http://[::1]:11434" })).not.toThrow();
  });

  it("rejects a non-http scheme", () => {
    expect(() => ollamaEngine({ baseUrl: "file:///etc/passwd" })).toThrow(/must use http/i);
  });
});

// The timeout must bound the WHOLE operation (connect + body/stream), not just the
// connect/header phase — a 200 with a stalled body, or a pull whose stream goes
// silent, must fail fast with a descriptive message, never hang. Short injected
// timeouts keep these tests quick.
describe("ollamaEngine — whole-operation timeouts (no hangs)", () => {
  it("generate: 200 headers then a stalled body is bounded by the timeout, not hung", async () => {
    // Send the status line but NEVER the body and NEVER end — the classic header-stall.
    const base = await startRawServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      // deliberately no res.write(body) / res.end(): the body never arrives
    });
    const engine = ollamaEngine({ baseUrl: base, timeoutMs: 250 });
    const started = Date.now();
    await expect(engine.generate("m", "hi")).rejects.toThrow(/took too long/i);
    // proves it didn't hang: resolved well within a few multiples of the timeout
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("pull: a stream that goes silent trips the idle timeout with a descriptive message", async () => {
    // Stream two progress chunks, then keep the connection open and send nothing more.
    const base = await startRawServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write(JSON.stringify({ status: "pulling manifest" }) + "\n");
      res.write(JSON.stringify({ status: "downloading", completed: 10, total: 100 }) + "\n");
      // then silence — no further chunks, no end
    });
    const engine = ollamaEngine({ baseUrl: base, pullIdleMs: 250 });
    const ticks: PullProgress[] = [];
    const started = Date.now();
    await expect(engine.pull("qwen2.5:3b", (p) => ticks.push(p))).rejects.toThrow(/stalled/i);
    expect(Date.now() - started).toBeLessThan(5000);
    // it DID make progress before stalling (so the failure is a genuine mid-stream stall)
    expect(ticks.length).toBeGreaterThan(0);
  });

  it("pull: a slow-but-STEADY stream succeeds even past a fixed cap (idle-based, not total)", async () => {
    // Emit chunks every ~80ms for a total (~800ms) far beyond the 250ms idle cap. Each
    // chunk resets the idle timer, so a healthy download never trips — proving the cap
    // is idle-based, not a total wall-clock limit that would kill a big model.
    const base = await startRawServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      let i = 0;
      const total = 10;
      const tick = (): void => {
        if (i >= total) {
          res.write(JSON.stringify({ status: "success" }) + "\n");
          res.end();
          return;
        }
        res.write(JSON.stringify({ status: "downloading", completed: i * 10, total: 100 }) + "\n");
        i++;
        setTimeout(tick, 80);
      };
      tick();
    });
    const engine = ollamaEngine({ baseUrl: base, pullIdleMs: 250 });
    const ticks: PullProgress[] = [];
    const started = Date.now();
    await engine.pull("qwen2.5:3b", (p) => ticks.push(p));
    // it ran longer than the idle cap (proving idle-based) and still completed
    expect(Date.now() - started).toBeGreaterThan(250);
    expect(ticks.map((t) => t.status)).toContain("success");
  });
});
