import { app } from "electron";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChatMessage, ChatMeta, ChatTokenEvent, ChatView } from "../shared/chat.js";

// Main-owned chat storage (TRUSTED main only), patterned on receipts.ts: a small
// `userData/chats/index.json` (the newest-first sidebar list) plus one append-only
// `<id>.jsonl` per chat. The renderer never touches disk — every write comes through
// here, so a single in-process writer is enough (main is the sole writer; loop 023's
// single-instance lock keeps a rival process from racing it).

// A chat id becomes a filename, so re-validate the charset at the path sink (mirror
// download.ts `modelPath`): a hostile id with `..`/separators can never write or read
// outside `userData/chats/`. New ids are UUIDs, which always pass this.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function chatsDir(): string {
  return path.join(app.getPath("userData"), "chats");
}

function indexFile(): string {
  return path.join(chatsDir(), "index.json");
}

// The one place a chat id becomes a path. Throws on a bad id BEFORE any fs call.
export function chatPath(id: string): string {
  if (id.includes("..") || !SAFE_ID.test(id)) {
    throw new Error("That chat id isn't allowed.");
  }
  return path.join(chatsDir(), `${id}.jsonl`);
}

// ── single-writer queue (mirror receipts.ts) ────────────────────────────────────────
// Serialize every mutation so a concurrent append + index rewrite can't interleave.
let writeTail: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => T | Promise<T>): Promise<T> {
  const run = writeTail.then(work, work);
  writeTail = run.catch(() => {});
  return run;
}

function ensureDir(): void {
  mkdirSync(chatsDir(), { recursive: true });
}

function readIndex(): ChatMeta[] {
  let raw: string;
  try {
    raw = readFileSync(indexFile(), "utf8");
  } catch {
    return []; // no chats yet
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ChatMeta =>
        m !== null &&
        typeof m === "object" &&
        typeof (m as ChatMeta).id === "string" &&
        typeof (m as ChatMeta).title === "string",
    );
  } catch {
    return []; // corrupt index → treat as empty rather than crash the page
  }
}

function writeIndex(list: ChatMeta[]): void {
  ensureDir();
  writeFileSync(indexFile(), JSON.stringify(list));
}

/** The sidebar list, newest-first by `updatedAt`. */
export function listChats(): ChatMeta[] {
  return readIndex().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** One conversation's meta + messages, or null if the chat is unknown. */
export function getChat(id: string): ChatView | null {
  const meta = readIndex().find((m) => m.id === id);
  if (!meta) return null;
  let raw: string;
  try {
    raw = readFileSync(chatPath(id), "utf8");
  } catch {
    return { meta, messages: [] }; // no messages written yet
  }
  const messages: ChatMessage[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const obj = JSON.parse(line) as ChatMessage;
      if ((obj.role === "user" || obj.role === "assistant") && typeof obj.content === "string") messages.push(obj);
    } catch {
      // skip a half-written line rather than break the whole conversation
    }
  }
  return { meta, messages };
}

/** Create an empty chat (title derived later, from its first user message). */
export function newChat(nowIso: string = new Date().toISOString()): Promise<ChatMeta> {
  return serialize(() => {
    const meta: ChatMeta = { id: randomUUID(), title: "", createdAt: nowIso, updatedAt: nowIso };
    writeIndex([meta, ...readIndex()]);
    return meta;
  });
}

export function renameChat(id: string, title: string): Promise<void> {
  const clean = title.trim().slice(0, 200);
  return serialize(() => {
    const list = readIndex();
    const meta = list.find((m) => m.id === id);
    if (meta) {
      meta.title = clean;
      writeIndex(list);
    }
  });
}

/** Remove a chat: its index entry AND its `<id>.jsonl` from disk. */
export function deleteChat(id: string): Promise<void> {
  return serialize(() => {
    writeIndex(readIndex().filter((m) => m.id !== id));
    try {
      rmSync(chatPath(id), { force: true });
    } catch {
      // an unsafe id can't have a file; nothing to remove
    }
  });
}

// First user message → the chat's title (collapsed whitespace, capped). Keeps the
// sidebar readable without a second brain call (contract C5).
function deriveTitle(content: string): string {
  const t = content.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t || "New chat";
}

/** Append one message and bump the chat's `updatedAt`; the first user message also
 *  sets the (still-empty) title. Returns the possibly-updated meta. */
export function appendMessage(id: string, message: ChatMessage): Promise<ChatMeta | null> {
  return serialize(() => {
    const list = readIndex();
    const meta = list.find((m) => m.id === id);
    if (!meta) return null;
    ensureDir();
    appendFileSync(chatPath(id), JSON.stringify(message) + "\n");
    meta.updatedAt = message.ts;
    if (meta.title === "" && message.role === "user") meta.title = deriveTitle(message.content);
    writeIndex(list);
    return meta;
  });
}

// ── window-guarded token sender (ledger: onprogress-send-window-guard) ───────────────
// The minimal window surface the token sender needs — a real BrowserWindow, or a
// stand-in in tests. Kept tiny so the guard is unit-testable without electron.
export interface WindowLike {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
}

/** Send one streamed token to the renderer, tolerating a destroyed/absent window
 *  (mirror the plugin broker's `post()` try/catch): a window torn down mid-stream can
 *  never crash main with an unhandled throw. */
export function sendChatToken(win: WindowLike | null, event: ChatTokenEvent): void {
  try {
    if (win && !win.isDestroyed()) win.webContents.send("chat:token", event);
  } catch {
    // window gone between the guard and the send — a dropped token is harmless
  }
}
