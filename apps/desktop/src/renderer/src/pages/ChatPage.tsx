import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatMeta } from "../../../shared/chat.js";
import type { BrainStatusView } from "../../../shared/brain.js";

// "Chat" — talk to your brain, one conversation at a time, replies streaming in
// token-by-token. Separate chats persist across restarts. The renderer never touches
// disk or the brain: it drives everything by IPC and listens for tokens on `chat:token`.
export function ChatPage({ brain }: { brain: BrainStatusView | null }) {
  const [chats, setChats] = useState<ChatMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null); // in-progress reply, or null
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(""); // last send failure, shown so it's never silent
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  // A ref so the (once-registered) token listener always sees the current chat.
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const configured = brain?.configured ?? false;
  const leavesMachine = configured && brain?.provider !== "local";

  const loadList = useCallback(async (): Promise<ChatMeta[]> => {
    const list = await window.deskhand.chat.list();
    setChats(list);
    return list;
  }, []);

  const openChat = useCallback(async (id: string): Promise<void> => {
    setActiveId(id);
    setStreaming(null);
    setError("");
    const view = await window.deskhand.chat.get(id);
    setMessages(view?.messages ?? []);
  }, []);

  // First load: show the newest chat, if any.
  useEffect(() => {
    void (async () => {
      const list = await loadList();
      if (list.length > 0 && list[0]) void openChat(list[0].id);
    })();
  }, [loadList, openChat]);

  // Stream tokens into the in-progress reply for the active chat.
  useEffect(() => {
    return window.deskhand.chat.onToken((e) => {
      if (e.chatId !== activeIdRef.current) return;
      setStreaming((prev) => (prev ?? "") + e.delta);
    });
  }, []);

  async function newChat(): Promise<void> {
    const meta = await window.deskhand.chat.new();
    await loadList();
    setActiveId(meta.id);
    setMessages([]);
    setStreaming(null);
    setDraft("");
  }

  async function send(): Promise<void> {
    const id = activeId;
    const text = draft.trim();
    if (!id || !text || sending || !configured) return;
    setError("");
    setDraft("");
    setMessages((m) => [...m, { role: "user", content: text, ts: new Date().toISOString() }]);
    setStreaming("");
    setSending(true);
    const res = await window.deskhand.chat.send(id, text);
    setSending(false);
    setStreaming(null);
    // Never leave a failure silent: show what went wrong (the reason is on the dev
    // terminal). Empty/error → the composer stays usable so the user can retry.
    if (!res.ok) setError(res.message ?? "Something went wrong. Try again.");
    // Re-read the authoritative messages (the assistant reply is now on disk) and refresh
    // the list so its newest-first order + derived title update.
    const view = await window.deskhand.chat.get(id);
    setMessages(view?.messages ?? []);
    await loadList();
  }

  function stop(): void {
    if (activeId) void window.deskhand.chat.stop(activeId);
  }

  async function remove(id: string): Promise<void> {
    await window.deskhand.chat.delete(id);
    const list = await loadList();
    if (activeId === id) {
      if (list.length > 0 && list[0]) void openChat(list[0].id);
      else {
        setActiveId(null);
        setMessages([]);
      }
    }
  }

  async function saveRename(id: string): Promise<void> {
    await window.deskhand.chat.rename(id, renameText);
    setRenamingId(null);
    await loadList();
  }

  const titleOf = (m: ChatMeta): string => (m.title.trim().length > 0 ? m.title : "New chat");

  return (
    <section className="page chat-page">
      <aside className="chat-list" aria-label="Your chats">
        <button className="primary chat-new" onClick={() => void newChat()}>
          New chat
        </button>
        {chats.length === 0 ? (
          <p className="hint">No chats yet. Start one above.</p>
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
                      onKeyDown={(e) => e.key === "Enter" && void saveRename(c.id)}
                    />
                    <button className="link" onClick={() => void saveRename(c.id)}>
                      Save name
                    </button>
                  </div>
                ) : (
                  <>
                    <button className="chat-title" onClick={() => void openChat(c.id)}>
                      {titleOf(c)}
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
                        <button className="link" onClick={() => void remove(c.id)}>
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

      <div className="chat-main">
        <header className="page-head">
          <h1>Chat</h1>
          <p>Talk to your brain. Each chat is saved on this computer.</p>
        </header>

        {leavesMachine && (
          <p className="notice chat-cloud-note">
            Heads up: this brain runs online, so what you type here leaves your computer.
          </p>
        )}

        {activeId === null ? (
          <p className="hint">Start a new chat to begin.</p>
        ) : (
          <>
            <div className="thread chat-thread">
              {messages.length === 0 && streaming === null ? (
                <p className="hint">Say something to get started.</p>
              ) : (
                messages.map((m, i) => (
                  <div key={i} className={m.role === "user" ? "bubble from-you" : "bubble from-brain"}>
                    <span className="who">{m.role === "user" ? "You" : "Your brain"}</span>
                    <p>{m.content}</p>
                  </div>
                ))
              )}
              {sending && streaming !== null && (
                <div className="bubble from-brain">
                  <span className="who">Your brain</span>
                  <p>{streaming.length > 0 ? streaming : "…"}</p>
                </div>
              )}
            </div>

            <div className="form chat-composer">
              <textarea
                aria-label="Message your brain"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={configured ? "Type your message…" : "Connect a brain in Settings first"}
                rows={3}
                disabled={!configured || sending}
              />
              {sending ? (
                <button className="primary" onClick={stop}>
                  Stop
                </button>
              ) : (
                <button className="primary" onClick={() => void send()} disabled={!configured || draft.trim().length === 0}>
                  Send
                </button>
              )}
              {!configured && <p className="notice">Connect a brain in Settings first, then come back to chat.</p>}
              {error.length > 0 && (
                <p className="notice chat-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
