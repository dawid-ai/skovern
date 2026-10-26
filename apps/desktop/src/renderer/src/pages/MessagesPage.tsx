import { useEffect, useState } from "react";
import type { ThreadMessageView } from "../../../shared/cloud.js";
import { Icon } from "../components/Icon.js";

// "Messages" — a two-way conversation with the founder. Messages are polled by
// the Shell (which owns the unread badge) and passed in; this page renders the
// thread, marks it read while open, and sends new messages.
export function MessagesPage({
  messages,
  onChanged,
}: {
  messages: ThreadMessageView[];
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // While this page is open, seeing the thread means it's read — mark it and
  // refresh so the nav badge clears. Re-runs when new replies arrive.
  useEffect(() => {
    void window.skovern.dm.read().then(onChanged);
  }, [messages.length, onChanged]);

  async function send() {
    setBusy(true);
    setNotice("");
    const res = await window.skovern.dm.send(text);
    setBusy(false);
    setNotice(res.message);
    if (res.ok) {
      setText("");
      onChanged();
    }
  }

  return (
    <section className="page page-narrow">
      <header className="page-head">
        <h1>Messages</h1>
        <p>A question, an idea, a bug — this goes straight to Dawid, the person building this.</p>
      </header>

      <div className="thread messages-thread">
        {messages.length === 0 ? (
          <p className="hint">No messages yet. Say hi below.</p>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={m.sender === "founder" ? "bubble from-founder" : "bubble from-you"}>
              <span className="who">{m.sender === "founder" ? "Dawid" : "You"}</span>
              <p>{m.body}</p>
            </div>
          ))
        )}
      </div>

      <div className="form messages-composer">
        <div className="cbox">
          <textarea
            aria-label="Your message"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type your message…"
            rows={1}
          />
          <button
            className="send"
            onClick={() => void send()}
            disabled={busy || text.trim().length === 0}
            aria-label="Send"
            title="Send"
          >
            <Icon name="arrowUp" />
          </button>
        </div>
        {notice.length > 0 && <p className="notice">{notice}</p>}
      </div>
    </section>
  );
}
