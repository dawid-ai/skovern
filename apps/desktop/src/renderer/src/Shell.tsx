import { useState } from "react";
import { NewsPage } from "./pages/NewsPage.js";
import { MessagesPage } from "./pages/MessagesPage.js";

// The signed-in app shell: a persistent left nav + a main area that shows one
// dedicated page at a time. New features become new nav items + pages here —
// never another block piled onto an existing page (CLAUDE.md UI IA rule).

type Page = "news" | "messages";

const NAV: { id: Page; label: string }[] = [
  { id: "news", label: "What's new" },
  { id: "messages", label: "Messages" },
];

export function Shell({ ogNumber, onSignOut }: { ogNumber: number | null; onSignOut: () => void }) {
  const [page, setPage] = useState<Page>("news");

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
                {item.label}
              </button>
            </li>
          ))}
        </ul>

        <div className="sidebar-foot">
          {ogNumber !== null && <p className="og-badge">Founding user #{ogNumber}</p>}
          <button className="link" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </nav>

      <main className="content">{page === "news" ? <NewsPage /> : <MessagesPage />}</main>
    </div>
  );
}
