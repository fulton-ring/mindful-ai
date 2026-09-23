import type { EditProposal } from '@walden/contracts';
import { isRedundantAddition, markdownBlocks } from '@walden/domain';
import { Hono } from 'hono';
import { z } from 'zod';
import { HttpError, jsonBody, newId } from '../../http';
import type { Bindings, Variables } from '../../types';
import { loadConversation } from '../conversations/conversations';
import { loadNote } from '../followups/followups';

const requestSchema = z
  .object({
    text: z.string().min(1).max(20_000),
    noteRevision: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const capturePlacementRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Placement is provisional. The caller applies the anchored insertion to its
// latest draft and saves with the normal optimistic note revision contract.
capturePlacementRoutes.post('/conversations/:id/capture-placement', async (c) => {
  const parsed = requestSchema.safeParse(await jsonBody(c));
  if (!parsed.success || !parsed.data.text.trim())
    throw new HttpError(400, 'Select some text to add.');
  const startedAt = performance.now();
  let lookupMs = 0;
  const placementMs = 0;
  const recordTiming = () =>
    c.header(
      'Server-Timing',
      `note_lookup;dur=${lookupMs.toFixed(1)}, model_placement;dur=${placementMs.toFixed(1)}`,
    );
  const ownerId = c.get('userId');
  const conversation = await loadConversation(c.env.DB, ownerId, c.req.param('id'));
  const note = await loadNote(c.env.DB, ownerId, conversation.noteId);
  lookupMs = performance.now() - startedAt;
  if ((note?.revision ?? null) !== parsed.data.noteRevision) {
    recordTiming();
    throw new HttpError(409, 'The note changed. Try adding the text again.');
  }
  // Already captured, verbatim or reworded. Explicit capture shares the note's
  // no-restatement rule: without this, "Add to note" happily inserts a sentence
  // the note already makes, and lands it above any pending proposal.
  if (
    note?.markdown.includes(parsed.data.text) ||
    markdownBlocks(note?.markdown ?? '').some((block) =>
      isRedundantAddition(block.text, parsed.data.text),
    )
  ) {
    recordTiming();
    return c.json({ proposal: null });
  }
  // An addition is its text. Nothing here decides where it goes: the note is
  // plain text and placement is recomputed wherever the edit is applied, so
  // this cannot hand back a position that is already out of date.
  const proposal: EditProposal = {
    id: newId(),
    noteId: note?.id ?? 'unsaved-note',
    baseRevision: note?.revision ?? 0,
    oldText: '',
    newText: parsed.data.text,
    reason: 'Add the selected text.',
    status: 'pending',
  };
  c.req.raw.signal.throwIfAborted();
  recordTiming();
  return c.json({ proposal });
});
