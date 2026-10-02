// Pure decision for deleting a downloaded model — kept out of the Electron-coupled `local.ts` so
// the "don't leave a dangling active brain" invariant is unit-testable (loop 041, checker F1).

/** Given the file being deleted, the active brain (its model id + the filename stored with it at
 *  save time, when known), whether the engine is warm, and the embedded catalog (id ↔ filename),
 *  decide: is this the ACTIVE model, should we UNLOAD its VRAM first (it's active AND resident —
 *  the warm child holds the weights even after the file is gone), and should we CLEAR the brain
 *  pointer (it's active → nothing must dangle at a deleted file)? */
export function modelDeletionPlan(
  filename: string,
  active: { id: string | null; filename: string | null },
  warm: boolean,
  embedded: { id: string; filename: string }[],
): { isActive: boolean; unload: boolean; clearBrain: boolean } {
  // The brain's own stored filename wins, so a vanished catalog entry can't make the active model
  // read as not-active (ledger `model-delete-active-catalog-edge`). Brains saved before 045 carry
  // no filename — those fall back to the catalog mapping.
  const cat = embedded.find((m) => m.filename === filename);
  const isActive = (active.filename !== null && active.filename === filename) || (cat !== undefined && cat.id === active.id);
  return { isActive, unload: isActive && warm, clearBrain: isActive };
}
