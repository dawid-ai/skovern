import { useState } from "react";
import { noticeCopy } from "./update-copy.js";
import { useUpdates } from "./use-updates.js";

// The small update notice, top-right on every page. It never downloads or restarts on its
// own: each step waits for a click. "Later" hides this message; Settings → Updates still has it.
export function UpdateNotice() {
  const { view, run } = useUpdates();
  const [hidden, setHidden] = useState<string | null>(null);
  const copy = view ? noticeCopy(view) : null;
  if (!copy || copy.key === hidden) return null;

  return (
    <aside className="update-notice" role="status" aria-label="Skovern update">
      <p className="update-notice-title">{copy.title}</p>
      {copy.percent !== undefined && (
        <div className="update-progress" aria-hidden="true">
          <span style={{ width: `${copy.percent}%` }} />
        </div>
      )}
      {/* Release notes arrive as plain text from main; rendered as text, never as HTML. */}
      {copy.body && <p className="update-notice-body">{copy.body}</p>}
      <div className="row">
        {copy.action && (
          <button className="primary" onClick={() => run(copy.action!.op)}>
            {copy.action.label}
          </button>
        )}
        <button className="link" onClick={() => setHidden(copy.key)}>
          Later
        </button>
      </div>
    </aside>
  );
}
