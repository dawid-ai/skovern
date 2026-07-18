// Pure decision for deleting a downloaded model — kept out of the Electron-coupled `local.ts` so
// the "don't leave a dangling active brain" invariant is unit-testable (loop 041, checker F1).

/** Given the file being deleted, the active brain's model id, whether the engine is warm, and the
 *  embedded catalog (id ↔ filename), decide: is this the ACTIVE model, should we UNLOAD its VRAM
 *  first (it's active AND resident — the warm child holds the weights even after the file is gone),
 *  and should we CLEAR the brain pointer (it's active → nothing must dangle at a deleted file)? */
export function modelDeletionPlan(
  filename: string,
  activeId: string | null,
  warm: boolean,
  embedded: { id: string; filename: string }[],
): { isActive: boolean; unload: boolean; clearBrain: boolean } {
  const cat = embedded.find((m) => m.filename === filename);
  // NB: if the active model's catalog entry has vanished (catalog changed), `cat` is undefined and
  // this reads as not-active — an accepted edge (the catalog snapshot is stable in practice).
  const isActive = cat !== undefined && cat.id === activeId;
  return { isActive, unload: isActive && warm, clearBrain: isActive };
}
