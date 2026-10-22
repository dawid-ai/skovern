import { describe, expect, it } from "vitest";
import { fromOllamaRegistry, ollamaPullHost } from "./ollama-name.js";

// SEC-047-2: a pull receipt names the host Ollama really downloads from — mirroring Ollama's own
// ParseNameBare (v0.40.6): only a name with three or more parts carries a host.
describe("ollamaPullHost", () => {
  it.each([
    ["qwen2.5:32b", "registry.ollama.ai"],
    ["gemma2:27b", "registry.ollama.ai"],
    ["library/qwen2.5:32b", "registry.ollama.ai"],
    ["hf.co/model", "registry.ollama.ai"], // two parts: "hf.co" is the namespace, as in Ollama
    ["hf.co/user/repo:Q4_K_M", "hf.co"],
    ["tracker.example/x/y", "tracker.example"],
    ["Tracker.Example:8080/x/y:latest", "tracker.example:8080"],
    ["http://evil.test/ns/m:tag", "evil.test"],
    ["registry.ollama.ai/library/qwen2.5", "registry.ollama.ai"],
  ])("%j → %j", (name, host) => {
    expect(ollamaPullHost(name)).toBe(host);
  });

  it("only registry names count as Ollama's own", () => {
    expect(fromOllamaRegistry("qwen2.5:32b")).toBe(true);
    expect(fromOllamaRegistry("hf.co/user/repo:Q4_K_M")).toBe(false);
    expect(fromOllamaRegistry("tracker.example/x/y")).toBe(false);
    expect(fromOllamaRegistry("http://registry.ollama.ai/library/x")).toBe(false); // plain http, even to the registry
  });
});
