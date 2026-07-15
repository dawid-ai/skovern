import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A controllable userData dir so chatsDir() points at a temp folder (mirror download.test).
const state = { dir: "" };
vi.mock("electron", () => ({ app: { getPath: () => state.dir } }));

import {
  appendMessage,
  chatPath,
  chatsDir,
  deleteChat,
  getChat,
  listChats,
  newChat,
  renameChat,
  sendChatToken,
  type WindowLike,
} from "./chat-store.js";

beforeEach(() => {
  state.dir = mkdtempSync(path.join(tmpdir(), "deskhand-chat-"));
});
afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true });
});

describe("chat-store", () => {
  // U1 — round-trip + newest-first ordering.
  it("U1: new → append → get round-trips; list is newest-first by updatedAt", async () => {
    const a = await newChat("2026-07-15T10:00:00.000Z");
    const b = await newChat("2026-07-15T11:00:00.000Z");

    await appendMessage(a.id, { role: "user", content: "hello there", ts: "2026-07-15T10:01:00.000Z" });
    await appendMessage(a.id, { role: "assistant", content: "hi!", ts: "2026-07-15T10:01:05.000Z" });

    const view = getChat(a.id);
    expect(view?.messages).toEqual([
      { role: "user", content: "hello there", ts: "2026-07-15T10:01:00.000Z" },
      { role: "assistant", content: "hi!", ts: "2026-07-15T10:01:05.000Z" },
    ]);
    // The first user message derived the title.
    expect(listChats().find((m) => m.id === a.id)?.title).toBe("hello there");

    // a was just updated (10:01:05) → now newer than b (created 11:00 but never touched?).
    // b's updatedAt is its createdAt 11:00 > a's 10:01:05, so b is still first.
    expect(listChats().map((m) => m.id)).toEqual([b.id, a.id]);

    // Touch a with a later message → a jumps to the front.
    await appendMessage(a.id, { role: "user", content: "still here", ts: "2026-07-15T12:00:00.000Z" });
    expect(listChats().map((m) => m.id)).toEqual([a.id, b.id]);
  });

  // U2 — rename updates the index; delete removes both the index entry and the jsonl.
  it("U2: rename updates the index; delete removes the entry and the file", async () => {
    const c = await newChat("2026-07-15T10:00:00.000Z");
    await appendMessage(c.id, { role: "user", content: "first", ts: "2026-07-15T10:00:01.000Z" });
    expect(existsSync(chatPath(c.id))).toBe(true);

    await renameChat(c.id, "My renamed chat");
    expect(listChats().find((m) => m.id === c.id)?.title).toBe("My renamed chat");

    await deleteChat(c.id);
    expect(listChats().find((m) => m.id === c.id)).toBeUndefined();
    expect(existsSync(chatPath(c.id))).toBe(false);
  });

  // U3 (security) — a chat id that isn't a safe slug is REFUSED at the path sink, never
  // writing/reading outside userData/chats/ (mirror download.ts modelPath).
  it("U3: an unsafe chat id is refused at the path sink", () => {
    for (const bad of ["../evil", "..", "a/b", "a\\b", "with space", ".hidden", ""]) {
      expect(() => chatPath(bad)).toThrow(/isn't allowed/);
    }
    // A safe slug (a UUID) resolves INSIDE the chats dir.
    const good = chatPath("11111111-2222-4333-8444-555555555555");
    expect(good.startsWith(chatsDir())).toBe(true);
    expect(good.includes("..")).toBe(false);
  });

  // U4 (security) — the token sender tolerates a destroyed/absent window without throwing
  // (mirror the broker's post() try/catch): a window torn down mid-stream can't crash main.
  it("U4: sendChatToken tolerates a null / destroyed / throwing window", () => {
    const evt = { chatId: "c", messageId: "m", delta: "hi" };

    // null window — no throw, no send.
    expect(() => sendChatToken(null, evt)).not.toThrow();

    // destroyed window — guarded out, never touches webContents.
    const sent: unknown[] = [];
    const destroyed: WindowLike = {
      isDestroyed: () => true,
      webContents: { send: (_c, p) => sent.push(p) },
    };
    expect(() => sendChatToken(destroyed, evt)).not.toThrow();
    expect(sent).toHaveLength(0);

    // a window whose send throws mid-stream — swallowed, never crashes main.
    const throwing: WindowLike = {
      isDestroyed: () => false,
      webContents: {
        send: () => {
          throw new Error("window gone");
        },
      },
    };
    expect(() => sendChatToken(throwing, evt)).not.toThrow();

    // a live window — the token actually goes out.
    const live: WindowLike = {
      isDestroyed: () => false,
      webContents: { send: (_c, p) => sent.push(p) },
    };
    sendChatToken(live, evt);
    expect(sent).toEqual([evt]);
  });

  // getChat on an unknown id → null (never a throw across IPC).
  it("getChat returns null for an unknown chat", () => {
    expect(getChat("11111111-2222-4333-8444-555555555555")).toBeNull();
  });
});
