/**
 * Whether a note proposal that started against `snapshot` still belongs to the
 * note currently on screen.
 *
 * A proposal asked for before the note existed snapshots a placeholder id, and
 * the note it creates on the way is the note it belongs to. Reading that as the
 * reader having switched notes threw the suggestion away the first time one was
 * ever asked for — and, on the batch path, returned before the stream was
 * marked finished, which left accepting disabled until the page was reloaded.
 */
export function proposalStillApplies(
  snapshot: { noteId: string } | null,
  current: { id: string } | null,
): boolean {
  if (!snapshot) return false;
  if (!current) return true;
  return snapshot.noteId === 'unsaved-note' || snapshot.noteId === current.id;
}
