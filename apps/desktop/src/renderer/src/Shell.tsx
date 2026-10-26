import { useCallback, useEffect, useState, type UIEvent } from "react";
import type { DmThreadView } from "../../shared/cloud.js";
import type { BrainStatusView } from "../../shared/brain.js";
import { NewsPage } from "./pages/NewsPage.js";
import { ChatPage } from "./pages/ChatPage.js";
import { Onboarding } from "./pages/Onboarding.js";
import { MessagesPage } from "./pages/MessagesPage.js";
import { SkillsPage } from "./pages/SkillsPage.js";
import { ReceiptsPage } from "./pages/ReceiptsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { YourBrainPage } from "./pages/YourBrainPage.js";
import { BrainChip } from "./components/BrainChip.js";
import { Icon, type IconName } from "./components/Icon.js";

// The signed-in app shell: a persistent left nav + a main area that shows one
// dedicated page at a time. New features become new nav items + pages here —
// never another block piled onto an existing page (CLAUDE.md UI IA rule).

// "onboarding" is a hidden view (not in NAV) reached from the first-run banner.
type Page = "news" | "chat" | "brain" | "messages" | "skills" | "receipts" | "settings" | "onboarding";

const NAV: { id: Page; label: string; icon: IconName }[] = [
  { id: "news", label: "What's new", icon: "sparkles" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "brain", label: "Your brain", icon: "brain" },
  { id: "messages", label: "Messages", icon: "envelope" },
  { id: "skills", label: "Skills", icon: "wand" },
  { id: "receipts", label: "Receipts", icon: "receipt" },
  { id: "settings", label: "Settings", icon: "sliders" },
];

// ponytail: naive polling keeps the founder-reply badge live without a push
// channel. Move to SSE/websocket (or a Telegram webhook fan-out) at scale.
const POLL_MS = 5000;

export function Shell({ ogNumber, onSignOut }: { ogNumber: number | null; onSignOut: () => void }) {
  const [page, setPage] = useState<Page>("news");
  const [thread, setThread] = useState<DmThreadView>({ messages: [], unread: 0 });
  const [brain, setBrain] = useState<BrainStatusView | null>(null);
  // The small toolbar title appears once the large page title scrolls under it.
  const [scrolled, setScrolled] = useState(false);

  const refresh = useCallback(async () => {
    setThread(await window.skovern.dm.thread());
  }, []);
  // The always-visible active-brain readout. Refetched when Settings changes it.
  const refreshBrain = useCallback(async () => {
    setBrain(await window.skovern.brain.status());
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
          // After onboarding sets up a brain, land in Chat — you just made a brain, so let
          // people USE it (Issue 5). Dumping them on "What's new" made no sense.
          refreshBrain();
          setPage("chat");
        }}
        onSkip={() => setPage("news")}
      />
    );
  }

  const onScroll = (e: UIEvent<HTMLElement>): void => setScrolled(e.currentTarget.scrollTop > 36);
  const label = NAV.find((n) => n.id === page)?.label ?? "";
  const fill = page === "chat"; // Chat lays out its own panes and toolbar; it never scrolls as a page.

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <div className="account-card">
          <span className="app-mark" aria-hidden="true">
            S
          </span>
          <span className="account-text">
            <b>Skovern</b>
            {ogNumber !== null && <span className="og-badge">Founding user #{ogNumber}</span>}
          </span>
        </div>

        <ul className="nav">
          {NAV.map((item) => (
            <li key={item.id}>
              <button
                className={page === item.id ? "nav-item active" : "nav-item"}
                aria-current={page === item.id ? "page" : undefined}
                title={item.label}
                onClick={() => {
                  setPage(item.id);
                  setScrolled(false);
                }}
              >
                <Icon name={item.icon} />
                <span className="nav-label">{item.label}</span>
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
          {brain !== null && <BrainChip brain={brain} />}
          <button className="link signout" onClick={onSignOut} title="Sign out">
            <Icon name="signOut" />
            <span className="signout-label">Sign out</span>
          </button>
        </div>
      </nav>

      <main
        className={`content${fill ? " content-fill" : ""}${scrolled && !fill ? " scrolled" : ""}`}
        onScroll={fill ? undefined : onScroll}
      >
        {!fill && <div className="toolbar" data-title={label} aria-hidden="true" />}
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
        {page === "brain" && <YourBrainPage onChanged={() => void refreshBrain()} onSetup={() => setPage("onboarding")} />}
        {page === "settings" && <SettingsPage onBrainChanged={refreshBrain} onOpenYourBrain={() => setPage("brain")} />}
      </main>
    </div>
  );
}
