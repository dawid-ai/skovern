import { useState } from "react";

// "Messages" — a direct line to the founder, on its own page. Send-only for now;
// loop 010 turns this into a two-way thread with history.
export function MessagesPage() {
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    setNotice("");
    const res = await window.deskhand.dm.send(text);
    setBusy(false);
    setNotice(res.message);
    if (res.ok) setText("");
  }

  return (
    <section className="page">
      <header className="page-head">
        <h1>Messages</h1>
        <p>A question, an idea, a bug — this goes straight to Dawid, the person building this.</p>
      </header>

      <div className="form">
        <textarea
          aria-label="Your message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type your message…"
          rows={4}
        />
        <button
          className="primary"
          onClick={() => void send()}
          disabled={busy || text.trim().length === 0}
        >
          Send
        </button>
        {notice.length > 0 && <p className="notice">{notice}</p>}
      </div>
    </section>
  );
}
