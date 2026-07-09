import { useEffect, useState } from "react";
import type { AppInfo } from "@deskhand/core";

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void window.deskhand.getAppInfo().then(setInfo);
  }, []);

  return (
    <main className="home">
      <div className="card">
        <div className="mark" aria-hidden="true">
          DH
        </div>
        <h1>Hi — I&apos;m your new desk hand.</h1>
        <p>
          I do real work for your business, right here on this computer.
          Private by default: nothing leaves this machine unless you say so.
        </p>
        <div className="actions">
          <button disabled>
            Check how AI sees my business <span>coming soon</span>
          </button>
          <button disabled>
            Watch my competitors <span>coming soon</span>
          </button>
          <button disabled>
            Connect a brain <span>coming soon</span>
          </button>
        </div>
        <footer>
          {info === null ? "starting…" : `${info.name} v${info.version} — running locally`}
        </footer>
      </div>
    </main>
  );
}
