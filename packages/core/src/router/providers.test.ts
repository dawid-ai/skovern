import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { anthropicProvider, openRouterProvider } from "./providers.js";

// Exercises the REAL AI SDK-backed adapters (both of them) against loopback
// mocks — so "two real backends behind one interface" is proven, not just the
// fake-provider interface. No network, no real keys.

let server: Server | undefined;

function mock(handler: (url: string) => unknown) {
  return new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(handler(req.url ?? "")));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(() => {
  server?.close();
  server = undefined;
});

describe("real provider adapters", () => {
  it("openRouterProvider drives the OpenAI-compatible chat completions shape", async () => {
    const base = await mock(() => ({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "mock",
      choices: [{ index: 0, message: { role: "assistant", content: "hi from openrouter" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }));
    const provider = openRouterProvider({ apiKey: "sk-test", baseURL: base });
    expect(provider.id).toBe("openrouter");
    expect(await provider.generate("hello")).toBe("hi from openrouter");
  });

  it("anthropicProvider drives the Anthropic messages shape", async () => {
    const base = await mock(() => ({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-3-5-haiku-latest",
      content: [{ type: "text", text: "hi from claude" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    }));
    const provider = anthropicProvider({ apiKey: "sk-test", baseURL: `${base}/v1` });
    expect(provider.id).toBe("anthropic");
    expect(await provider.generate("hello")).toBe("hi from claude");
  });

  it("refuses a non-https, non-loopback base URL (no plaintext exfil)", () => {
    expect(() => openRouterProvider({ apiKey: "k", baseURL: "http://evil.example/v1" })).toThrow(/https/);
    expect(() => anthropicProvider({ apiKey: "k", baseURL: "http://evil.example/v1" })).toThrow(/https/);
    // https to a real host is fine
    expect(() => openRouterProvider({ apiKey: "k", baseURL: "https://proxy.example/v1" })).not.toThrow();
  });
});
