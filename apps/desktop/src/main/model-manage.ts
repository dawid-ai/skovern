// Pure decision for deleting a downloaded model — kept out of the Electron-coupled `local.ts` so
// the "don't leave a dangling active brain" invariant is unit-testable (loop 041, checker F1).

/** Is this downloaded file the ACTIVE brain's? The brain's own stored filename counts, so a vanished
 *  catalog entry can't make the active model read as not-active (ledger
 *  `model-delete-active-catalog-edge`). Brains saved before 045 carry no filename — those rely on
 *  the catalog mapping alone. One rule for both the "in use" marker and deletion (loop 045). */
export function isActiveFile(
  filename: string,
  active: { id: string | null; filename: string | null },
  embedded: { id: string; filename: string }[],
): boolean {
  // Either signal marks it active — the stricter-for-deletion union: the stored filename survives a
  // vanished/renamed catalog entry, and the catalog mapping still catches a file the runtime would
  // load for this id (catalog kept the id but changed the file) — never a dangling brain pointer.
  if (active.filename !== null && active.filename === filename) return true;
  const cat = embedded.find((m) => m.filename === filename);
  return cat !== undefined && cat.id === active.id;
}

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
  const isActive = isActiveFile(filename, active, embedded);
  return { isActive, unload: isActive && warm, clearBrain: isActive };
}
