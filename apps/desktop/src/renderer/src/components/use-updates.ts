import { useEffect, useState } from "react";
import type { UpdatesView } from "../../../shared/updates.js";
import type { UpdateOp } from "./update-copy.js";

// Live update state for any component: the cached state first (main may have checked before
// this view mounted), then every change main pushes.
export function useUpdates(): { view: UpdatesView | null; run: (op: UpdateOp) => void; setAuto: (on: boolean) => void } {
  const [view, setView] = useState<UpdatesView | null>(null);

  useEffect(() => {
    let live = true;
    const off = window.skovern.updates.onEvent((v) => setView(v));
    void window.skovern.updates.current().then((v) => {
      if (live) setView((prev) => prev ?? v);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  const run = (op: UpdateOp): void => {
    void window.skovern.updates[op]().then(setView);
  };
  const setAuto = (on: boolean): void => {
    void window.skovern.updates.setAuto(on).then(setView);
  };
  return { view, run, setAuto };
}
