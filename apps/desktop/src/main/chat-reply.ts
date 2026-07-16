// Pure decision for what a chat turn SAVES and reports — shared by the success and error
// paths of chatSend (index.ts). Kept dependency-free so it's unit-testable without mocking
// Electron. Issue 6: a generation that streams tokens then fails (the model filled its
// context window) must KEEP the streamed partial, never drop the turn to a blank bubble.

export type ChatReplyDecision =
  | { save: string; cutoff: boolean } // persist `save`; cutoff → add the "cut off" note
  | { save: null; reason: "empty" | "error" }; // nothing to save; reason picks the message

/** Given the engine's final text, the text we actually streamed to the screen, and whether
 *  the generation threw, decide what to persist. The streamed partial is a real answer. */
export function resolveChatReply(input: { resText: string; streamed: string; errored: boolean }): ChatReplyDecision {
  const { resText, streamed, errored } = input;
  if (errored) {
    // Errored mid-generation: if text already streamed, it's a real (cut-off) partial — keep it.
    return streamed.length > 0 ? { save: streamed, cutoff: true } : { save: null, reason: "error" };
  }
  // Success: the engine's text is authoritative; fall back to the streamed partial if it's empty.
  const reply = resText.length > 0 ? resText : streamed;
  return reply.length > 0 ? { save: reply, cutoff: false } : { save: null, reason: "empty" };
}
