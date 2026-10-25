import { settingsCopy } from "./update-copy.js";
import { useUpdates } from "./use-updates.js";

// Settings → Updates: which version you have, a manual check, and the automatic-check switch.
export function UpdatesSection() {
  const { view, run, setAuto } = useUpdates();
  if (!view) return null;
  const copy = settingsCopy(view);

  return (
    <div className="form updates-settings">
      <h2>Updates</h2>
      <p className="updates-version">
        You have <strong>Skovern {view.current}</strong>.
      </p>
      <p className="hint" role="status">
        {view.state.kind === "checking" && <span className="spinner" aria-hidden="true" />} {copy.status}
      </p>
      <div className="row">
        <button className={copy.action ? "link" : "primary"} onClick={() => run("check")} disabled={copy.checkDisabled}>
          Check for updates
        </button>
        {copy.action && (
          <button className="primary" onClick={() => run(copy.action!.op)}>
            {copy.action.label}
          </button>
        )}
      </div>
      {view.canUpdate && (
        <label className="updates-auto">
          <input type="checkbox" checked={view.auto} onChange={(e) => setAuto(e.target.checked)} /> Check for updates automatically
        </label>
      )}
    </div>
  );
}
