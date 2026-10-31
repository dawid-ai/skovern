import { settingsCopy } from "./update-copy.js";
import { useUpdates } from "./use-updates.js";

// Settings → Updates: which version you have, a manual check, and the automatic-check switch.
export function UpdatesSection() {
  const { view, run, setAuto } = useUpdates();
  if (!view) return null;
  const copy = settingsCopy(view);

  return (
    <section className="group updates-settings">
      <h2 className="g-head">Updates</h2>
      <div className="g-card">
        <div className="g-row">
          <p className="updates-version">
            You have <strong>Skovern {view.current}</strong>.
          </p>
        </div>
        <div className="g-row">
          <p className="hint g-main" role="status">
            {view.state.kind === "checking" && <span className="spinner" aria-hidden="true" />} {copy.status}
          </p>
          <span className="g-trail">
            {copy.action && (
              <button className="primary" onClick={() => run(copy.action!.op)}>
                {copy.action.label}
              </button>
            )}
            <button className="link" onClick={() => run("check")} disabled={copy.checkDisabled}>
              Check for updates
            </button>
          </span>
        </div>
        {view.canUpdate && (
          <label className="g-row updates-auto">
            <span className="g-main">Check for updates automatically</span>
            <input type="checkbox" className="switch" checked={view.auto} onChange={(e) => setAuto(e.target.checked)} />
          </label>
        )}
      </div>
    </section>
  );
}
