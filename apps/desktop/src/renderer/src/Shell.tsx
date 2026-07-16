import { useCallback, useEffect, useState } from "react";
import type { DmThreadView } from "../../shared/cloud.js";
import type { BrainStatusView } from "../../shared/brain.js";
import { providerShort } from "../../shared/brain.js";
import { NewsPage } from "./pages/NewsPage.js";
import { ChatPage } from "./pages/ChatPage.js";
import { Onboarding } from "./pages/Onboarding.js";
import { MessagesPage } from "./pages/MessagesPage.js";
import { SkillsPage } from "./pages/SkillsPage.js";
import { ReceiptsPage } from "./pages/ReceiptsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";

// The signed-in app shell: a persistent left nav + a main area that shows one
// dedicated page at a time. New features become new nav items + pages here —
// never another block piled onto an existing page (CLAUDE.md UI IA rule).

// "onboarding" is a hidden view (not in NAV) reached from the first-run banner.
type Page = "news" | "chat" | "messages" | "skills" | "receipts" | "settings" | "onboarding";

const NAV: { id: Page; label: string }[] = [
  { id: "news", label: "What's new" },
  { id: "chat", label: "Chat" },
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

  // Poll brain status too, so the chip's green/gray tracks the model loading and idle-unloading
  // (the model frees itself after 5 min unused). Same cheap interval as the DM poll.
  useEffect(() => {
    void refreshBrain();
    const id = setInterval(() => void refreshBrain(), POLL_MS);
    return () => clearInterval(id);
  }, [refreshBrain]);

  // First-run onboarding is a non-blocking PROMPT, not a gate: the shell stays usable (News,
  // Messages, Receipts need no brain), but a no-brain user gets a prominent banner into the
  // self-reliant built-in setup, and can open it as its own view. Once a brain is configured
  // the banner disappears.
  const needsBrain = brain !== null && !brain.configured;

  if (page === "onboarding") {
    return (
      <Onboarding
        onConfigured={() => {
          refreshBrain();
          setPage("news");
        }}
        onSkip={() => setPage("news")}
      />
    );
  }

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
            <div
              className={`brain-chip ${
                brain.provider === "local"
                  ? // Local brain: green when the model is loaded, gray when it's asleep (unloaded).
                    brain.modelLoaded
                    ? "brain-chip-local"
                    : "brain-chip-asleep"
                  : brain.configured
                    ? "brain-chip-online"
                    : "brain-chip-none"
              }`}
              title={
                brain.provider === "local"
                  ? brain.modelLoaded
                    ? "Your private brain is awake — nothing leaves this computer"
                    : "Your private brain is asleep — it wakes up when you chat"
                  : "Your active brain"
              }
            >
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
        {needsBrain && (
          <div className="brain-banner" role="note">
            <span>
              <strong>Set up your brain to get started.</strong> The easiest is a private one that
              runs free, right here on your computer — nothing to install yourself.
            </span>
            <button className="primary" onClick={() => setPage("onboarding")}>
              Set it up →
            </button>
          </div>
        )}
        {page === "news" && <NewsPage />}
        {page === "chat" && <ChatPage brain={brain} onSetup={() => setPage("onboarding")} />}
        {page === "messages" && <MessagesPage messages={thread.messages} onChanged={onChanged} />}
        {page === "skills" && <SkillsPage />}
        {page === "receipts" && <ReceiptsPage />}
        {page === "settings" && <SettingsPage onBrainChanged={refreshBrain} />}
      </main>
    </div>
  );
}
