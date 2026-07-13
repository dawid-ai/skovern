// The EMBEDDED runtime child: a forked plain-Node process (ELECTRON_RUN_AS_NODE) that
// loads node-llama-cpp's NATIVE runtime and runs a GGUF, isolated from Electron main so
// a native crash can't take the app down. It speaks a tiny IPC protocol with the parent
// (llama-engine.ts). node-llama-cpp is an OPTIONAL dep, dynamically imported: if it (or
// its platform binary) isn't present, the child reports "load-error" and the engine
// degrades honestly to "not available yet" — never a crash.
//
// This file is exercised in HAND-VALIDATION on a real machine (a real model, real
// inference); CI injects a fake child and never loads the native addon.

// Inlined so the child bundle never imports llama-engine.ts (which pulls in electron).
type ToChild = { type: "generate"; id: number; modelPath: string; prompt: string; contextSize: number };
type FromChild =
  | { type: "ready" }
  | { type: "load-error"; message: string }
  | { type: "result"; id: number; text: string; tokensIn?: number; tokensOut?: number }
  | { type: "error"; id: number; message: string };

function send(msg: FromChild): void {
  process.send?.(msg);
}

// Minimal shapes for the bits of node-llama-cpp we use (it's dynamically imported, so
// we type the surface locally rather than depend on its types at build time).
interface LlamaModel {
  createContext(o: { contextSize: number }): Promise<LlamaContext>;
  tokenize(text: string): unknown[];
}
interface LlamaContext {
  getSequence(): unknown;
}
interface Llama {
  loadModel(o: { modelPath: string }): Promise<LlamaModel>;
}
interface ChatSession {
  prompt(text: string): Promise<string>;
}

async function main(): Promise<void> {
  let llama: Llama;
  let ChatSessionCtor: new (o: { contextSequence: unknown }) => ChatSession;
  try {
    // why: node-llama-cpp is an optional native dep resolved at runtime, not build time.
    const mod = (await import("node-llama-cpp")) as unknown as {
      getLlama: () => Promise<Llama>;
      LlamaChatSession: new (o: { contextSequence: unknown }) => ChatSession;
    };
    llama = await mod.getLlama();
    ChatSessionCtor = mod.LlamaChatSession;
  } catch (e) {
    send({ type: "load-error", message: e instanceof Error ? e.message.slice(0, 200) : "runtime unavailable" });
    return;
  }
  send({ type: "ready" });

  // One loaded model per path, kept warm across calls.
  const models = new Map<string, LlamaModel>();
  async function modelFor(modelPath: string): Promise<LlamaModel> {
    const cached = models.get(modelPath);
    if (cached) return cached;
    const m = await llama.loadModel({ modelPath });
    models.set(modelPath, m);
    return m;
  }

  process.on("message", (msg: ToChild) => {
    if (!msg || msg.type !== "generate") return;
    void (async () => {
      try {
        const model = await modelFor(msg.modelPath);
        const context = await model.createContext({ contextSize: msg.contextSize });
        const session = new ChatSessionCtor({ contextSequence: context.getSequence() });
        const text = await session.prompt(msg.prompt);
        // Honest token counts from the model's own tokenizer.
        const tokensIn = model.tokenize(msg.prompt).length;
        const tokensOut = model.tokenize(text).length;
        send({ type: "result", id: msg.id, text, tokensIn, tokensOut });
      } catch (e) {
        send({ type: "error", id: msg.id, message: e instanceof Error ? e.message.slice(0, 200) : "generate failed" });
      }
    })();
  });
}

void main();
