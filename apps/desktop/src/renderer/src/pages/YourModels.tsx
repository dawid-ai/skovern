import { useCallback, useEffect, useState } from "react";
import type { YourModelsView } from "../../../shared/local.js";

// "Your models" (loop 041): the brains you've downloaded (disk) + what's loaded in your graphics
// card right now (VRAM), with Delete (reclaim disk) and Free memory (reclaim VRAM). Lives in the
// local-brain settings view. Talks ONLY to window.skovern.local.* — no disk/OS access here.
export function YourModels({ onChanged, refreshKey }: { onChanged: () => void; refreshKey: number }) {
  const [view, setView] = useState<YourModelsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null); // filename pending a confirm
  const [note, setNote] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    setView(await window.skovern.local.downloadedModels());
  }, []);

  // Re-fetch on mount AND whenever the parent signals a change (a download finished, a rescan) —
  // so a just-downloaded model appears here without a manual reopen.
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  async function del(filename: string): Promise<void> {
    setBusy(true);
    setConfirming(null);
    const res = await window.skovern.local.deleteModel(filename);
    setBusy(false);
    setNote(res.ok ? "" : res.message);
    await refresh();
    onChanged(); // deleting the active brain clears it — let the parent re-check status
  }

  async function free(): Promise<void> {
    setBusy(true);
    const { freed } = await window.skovern.local.freeMemory();
    setBusy(false);
    setNote(freed ? "" : "A reply is being written right now — try again in a moment.");
    await refresh();
  }

  if (!view) return null;
  const { models, loadedLabel } = view;

  return (
    <div className="local-group your-models">
      <h2>Your models</h2>
      <p className="hint">
        The brains you&apos;ve downloaded. Delete one to free up disk space — you can always download
        it again later.
      </p>

      {/* Memory row: what's loaded in your graphics card right now, with a way to free it. */}
      <div className="your-models-memory">
        {loadedLabel ? (
          <>
            <span>
              In memory now: <strong>{loadedLabel}</strong>
            </span>
            <button className="link" onClick={() => void free()} disabled={busy}>
              Free memory
            </button>
          </>
        ) : (
          <span className="hint">Nothing is loaded in memory right now.</span>
        )}
      </div>

      {models.length === 0 ? (
        <p className="hint">You haven&apos;t downloaded any brains yet.</p>
      ) : (
        <div className="receipt-scroll">
          <table className="receipt-table your-models-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Size on disk</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.filename} className="receipt-row">
                  <td className="receipt-what">
                    <span className="receipt-who">{m.label}</span>
                    {m.active && <span className="local-status status-active"> · in use</span>}
                  </td>
                  <td>{m.size}</td>
                  <td className="local-action-cell">
                    {confirming === m.filename ? (
                      <span className="row">
                        <button className="link danger" onClick={() => void del(m.filename)} disabled={busy}>
                          Yes, delete
                        </button>
                        <button className="link" onClick={() => setConfirming(null)} disabled={busy}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button className="link danger" onClick={() => setConfirming(m.filename)} disabled={busy}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {note.length > 0 && <p className="notice">{note}</p>}
    </div>
  );
}
