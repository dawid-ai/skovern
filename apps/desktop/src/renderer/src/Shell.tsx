import { useCallback, useEffect, useState } from "react";
import type { DmThreadView } from "../../shared/cloud.js";
import type { BrainStatusView } from "../../shared/brain.js";
import { providerShort } from "../../shared/brain.js";
import { NewsPage } from "./pages/NewsPage.js";
import { MessagesPage } from "./pages/MessagesPage.js";
import { SkillsPage } from "./pages/SkillsPage.js";
import { ReceiptsPage } from "./pages/ReceiptsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

// The signed-in app shell: a persistent left nav + a main area that shows one
// dedicated page at a time. New features become new nav items + pages here —
// never another block piled onto an existing page (CLAUDE.md UI IA rule).

type Page = "news" | "messages" | "skills" | "receipts" | "settings";

const NAV: { id: Page; label: string }[] = [
  { id: "news", label: "What's new" },
  { id: "messages", label: "Messages" },
  { id: "skills", label: "Skills" },
  { id: "receipts", label: "Receipts" },
  { id: "settings", label: "Settings" },
];

// ponytail: naive polling keeps the founder-reply badge live without a push
// channel. Move to SSE/websocket (or a Telegram webhook fan-out) at scale.
const POLL_MS = 5000;

export function Shell({ ogNumber, onSignOut }: { ogNumber: number | null; onSignOut: () => void }) {
  const [page, setPage] = useState<Page>("news");
  const [thread, setThread] = useState<DmThreadView>({ messages: [], unread: 0 });
  const [brain, setBrain] = useState<BrainStatusView | null>(null);

  const refresh = useCallback(async () => {
    setThread(await window.deskhand.dm.thread());
  }, []);
  // The always-visible active-brain readout. Refetched when Settings changes it.
  const refreshBrain = useCallback(async () => {
    setBrain(await window.deskhand.brain.status());
  }, []);
  // Stable identity: passed to MessagesPage's effect deps, so it must not change
  // per render or the effect (mark-read + refresh) would loop every render.
  const onChanged = useCallback(() => void refresh(), [refresh]);

  // Poll for new founder replies so the Messages badge stays live off-page.
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    void refreshBrain();
  }, [refreshBrain]);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            DH
          </span>
          <span className="brand-name">Deskhand</span>
        </div>

        <ul className="nav">
          {NAV.map((item) => (
            <li key={item.id}>
              <button
                className={page === item.id ? "nav-item active" : "nav-item"}
                aria-current={page === item.id ? "page" : undefined}
                onClick={() => setPage(item.id)}
              >
                <span>{item.label}</span>
                {/* No badge on the page you're already reading. */}
                {item.id === "messages" && page !== "messages" && thread.unread > 0 && (
                  <span className="nav-badge" aria-label={`${thread.unread} unread`}>
                    {thread.unread}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>

        <div className="sidebar-foot">
          {ogNumber !== null && <p className="og-badge">Founding user #{ogNumber}</p>}
          {brain !== null && (
            <div className="brain-chip" title="Your active brain">
              <span className="brain-dot" aria-hidden="true" />
              {brain.configured && brain.provider ? (
                <span className="brain-chip-text">
                  {providerShort(brain.provider)}
                  {brain.model ? `: ${brain.model}` : ""}
                </span>
              ) : (
                <span className="brain-chip-text brain-chip-empty">No brain yet</span>
              )}
            </div>
          )}
          <button className="link" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </nav>

      <main className="content">
        {page === "news" && <NewsPage />}
        {page === "messages" && <MessagesPage messages={thread.messages} onChanged={onChanged} />}
        {page === "skills" && <SkillsPage />}
        {page === "receipts" && <ReceiptsPage />}
        {page === "settings" && <SettingsPage onBrainChanged={refreshBrain} />}
      </main>
    </div>
  );
}
