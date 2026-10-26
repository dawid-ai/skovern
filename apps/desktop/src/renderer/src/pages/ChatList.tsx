import { useState } from "react";
import type { ChatMeta } from "../../../shared/chat.js";
import { Icon } from "../components/Icon.js";

// The chat list column on the Chat page (design A: like Messages on a Mac). Pure view: every
// action is the parent's, so the list never touches IPC itself.

// An untitled (empty) chat reads "Untitled chat" — NOT "New chat", which would collide with the
// "New chat" button now that Chat auto-opens an empty chat on arrival.
export const titleOf = (m: ChatMeta): string => (m.title.trim().length > 0 ? m.title : "Untitled chat");

// When a chat last changed, short: a time today, "Yesterday", a weekday this week, else a date.
export function whenOf(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ChatList({
  chats,
  activeId,
  onNew,
  onOpen,
  onRename,
  onDelete,
}: {
  chats: ChatMeta[];
  activeId: string | null;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  async function save(id: string): Promise<void> {
    await onRename(id, renameText);
    setRenamingId(null);
  }

  return (
    <aside className="chat-list" aria-label="Your chats">
      <div className="chat-list-head">
        <h1>Chat</h1>
        <button className="icon-btn chat-new" onClick={onNew} aria-label="New chat" title="New chat">
          <Icon name="compose" />
        </button>
      </div>
      {chats.length === 0 ? (
        <p className="hint chat-list-empty">No chats yet. Start one above.</p>
      ) : (
        <ul>
          {chats.map((c) => (
            <li key={c.id} className={c.id === activeId ? "chat-row active" : "chat-row"}>
              {renamingId === c.id ? (
                <div className="chat-rename">
                  <input
                    aria-label="New name"
                    value={renameText}
                    onChange={(e) => setRenameText(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void save(c.id)}
                  />
                  <button className="link" onClick={() => void save(c.id)}>
                    Save name
                  </button>
                </div>
              ) : (
                <>
                  <button className="chat-title" onClick={() => onOpen(c.id)}>
                    <span className="chat-title-text">{titleOf(c)}</span>
                    <span className="chat-when">{whenOf(c.updatedAt)}</span>
                  </button>
                  {c.id === activeId && (
                    <div className="chat-row-actions">
                      <button
                        className="link"
                        onClick={() => {
                          setRenamingId(c.id);
                          setRenameText(titleOf(c));
                        }}
                      >
                        Rename
                      </button>
                      <button className="link" onClick={() => onDelete(c.id)}>
                        Delete
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
