import type { OllamaLaunch, OllamaStatusView, SettingsView } from "../../../shared/settings.js";

// Settings → Ollama (optional helper). Split out of SettingsPage in loop 049 (module size). The
// explanation comes first, then the question or the setting, so you know what Ollama is before
// you're asked about it. Pure view: every change goes through the parent's handlers.
export function OllamaSettings({
  ollama,
  settings,
  onLaunch,
  onUseBuiltin,
}: {
  ollama: OllamaStatusView;
  settings: SettingsView | null;
  onLaunch: (v: OllamaLaunch) => void;
  onUseBuiltin: () => void;
}) {
  return (
    <section className="group ollama-settings">
      <h2 className="g-head">Ollama (optional helper)</h2>
      <p className="g-intro">
        Ollama is a free helper that can run bigger brains on your computer. Skovern doesn&apos;t
        need it — your built-in brain works on its own.{" "}
        {ollama.installed
          ? ollama.running
            ? "It's installed and running."
            : "It's installed, but not running right now."
          : "It's not installed on this computer — that's perfectly fine."}
      </p>
      {ollama.installed && settings !== null && settings.ollamaLaunch === "ask" && (
        // The consent OFFER (default state): ask before ever starting Ollama for the user.
        <div className="g-card">
          <div className="g-row ollama-consent" role="group" aria-label="Use Ollama?">
            <p>
              We found Ollama on your computer. Want Skovern to start it automatically when you
              use an Ollama brain? You can change this anytime.
            </p>
            <div className="row">
              <button className="primary" onClick={() => onLaunch("always")}>
                Yes, start it automatically
              </button>
              <button className="link" onClick={onUseBuiltin}>
                No, use my built-in brain
              </button>
            </div>
          </div>
        </div>
      )}
      {ollama.installed && settings !== null && settings.ollamaLaunch !== "ask" && (
        <div className="g-card">
          <div className="g-row g-field">
            <label htmlFor="ollama-launch">If you pick an Ollama brain and Ollama isn&apos;t running:</label>
            <select
              id="ollama-launch"
              value={settings.ollamaLaunch}
              onChange={(e) => {
                const v = e.target.value as OllamaLaunch;
                // Picking "just use my built-in" with no model on disk → route to download it.
                if (v === "never") onUseBuiltin();
                else onLaunch(v);
              }}
            >
              <option value="always">Start Ollama for me automatically</option>
              <option value="never">Just use my built-in brain</option>
            </select>
          </div>
        </div>
      )}
    </section>
  );
}
