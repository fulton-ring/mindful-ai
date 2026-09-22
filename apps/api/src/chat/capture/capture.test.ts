import { describe, expect, it } from 'vitest';
import { appFor, capture, database, type State } from './capture.fixtures';

describe('atomic first-note capture with mock D1', () => {
  it('rejects a conversation owned by another user', async () => {
    const state: State = {
      ownerId: 'someone-else',
      noteId: null,
      status: 'active',
      streaming: false,
      notes: new Map(),
      edits: new Map(),
    };
    expect((await appFor(database(state))(capture)).status).toBe(404);
  });

  it('rejects capture when a note is already attached', async () => {
    const state: State = {
      ownerId: 'owner',
      noteId: 'existing',
      status: 'active',
      streaming: false,
      notes: new Map([['existing', { markdown: 'Existing', revision: 1, provenance: '[]' }]]),
      edits: new Map(),
    };
    expect((await appFor(database(state))(capture)).status).toBe(409);
  });

  it('rejects a streaming race without leaving a note attached', async () => {
    const state: State = {
      ownerId: 'owner',
      noteId: null,
      status: 'active',
      streaming: false,
      raceBeforeBatch: true,
      notes: new Map(),
      edits: new Map(),
    };
    expect((await appFor(database(state))(capture)).status).toBe(409);
    expect(state.noteId).toBeNull();
    expect(state.notes.size).toBe(0);
  });
});

describe('atomic first-note capture replay with mock D1', () => {
  it('atomically creates, records, and attaches one note, then replays the operation', async () => {
    const state: State = {
      ownerId: 'owner',
      noteId: null,
      status: 'active',
      streaming: false,
      notes: new Map(),
      edits: new Map(),
    };
    const request = appFor(database(state));

    const created = await request(capture);
    const replayed = await request(capture);

    expect(created.status).toBe(201);
    expect(replayed.status).toBe(200);
    const firstBody = (await created.json()) as { note: { id: string } };
    const replayBody = (await replayed.json()) as { note: { id: string } };
    expect(firstBody.note).toMatchObject({
      markdown: capture.text,
      revision: 1,
      provenance: [
        {
          from: 0,
          to: capture.text.length,
          origin: 'agent',
          verbatim: true,
          captureId: capture.operationId,
        },
      ],
    });
    expect(replayBody.note.id).toBe(firstBody.note.id);
    expect(state.notes.size).toBe(1);
    expect(state.edits.size).toBe(1);
    expect(state.noteId).toBe(firstBody.note.id);
  });
});
