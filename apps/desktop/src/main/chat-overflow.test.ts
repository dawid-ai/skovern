import { describe, expect, it } from "vitest";
import { resolveChatReply } from "./chat-reply.js";

// Loop 035 Issue 6 — a chat turn must NEVER drop to a blank bubble. A generation that streams
// tokens then errors (the model filled its context window) keeps the streamed partial + is
// flagged cut-off; only a truly empty turn (nothing streamed) reports an honest failure.

describe("resolveChatReply", () => {
  it("U1: streamed text then ERROR → keep the partial, flag it cut off", () => {
    const d = resolveChatReply({ resText: "", streamed: "Hello, this is a long repea", errored: true });
    expect(d).toEqual({ save: "Hello, this is a long repea", cutoff: true });
  });

  it("U2a: errored with NOTHING streamed → no save, bare error (composer shows a hint)", () => {
    expect(resolveChatReply({ resText: "", streamed: "", errored: true })).toEqual({ save: null, reason: "error" });
  });

  it("U2b: success with empty text AND nothing streamed → 'nothing' (honest, not blank)", () => {
    expect(resolveChatReply({ resText: "", streamed: "", errored: false })).toEqual({ save: null, reason: "empty" });
  });

  it("success → the engine's text is authoritative, not cut off", () => {
    expect(resolveChatReply({ resText: "full answer", streamed: "full answer", errored: false })).toEqual({ save: "full answer", cutoff: false });
  });

  it("success but engine returned empty while tokens DID stream → save the streamed partial", () => {
    expect(resolveChatReply({ resText: "", streamed: "partial", errored: false })).toEqual({ save: "partial", cutoff: false });
  });
});
