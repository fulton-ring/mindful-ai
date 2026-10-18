import { expect, it } from 'vitest';
import { openSqliteDatabase } from '../../../platform/node/sqlite';
import { agentHighlightStatements } from '../agent-highlights';

it('fences annotation cleanup by generation even when completion timestamps match', async () => {
  const db = openSqliteDatabase(':memory:');
  try {
    await db.exec(`CREATE TABLE turns(id TEXT,owner_id TEXT,status TEXT,completed_at TEXT,execution_generation INTEGER);
      CREATE TABLE message_highlights(message_id TEXT,owner_id TEXT,origin TEXT,quote TEXT);
      INSERT INTO turns VALUES('turn','owner','completed','same-time',2);
      INSERT INTO message_highlights VALUES('turn','owner','agent','Newer annotation');`);
    const input = {
      messageId: 'turn',
      ownerId: 'owner',
      content: 'Newer annotation',
      annotations: [],
      updatedAt: 'same-time',
      completedAt: 'same-time',
    };
    await db.batch(agentHighlightStatements(db, { ...input, executionGeneration: 1 }));
    expect((await db.prepare('SELECT quote FROM message_highlights').all()).results).toEqual([
      { quote: 'Newer annotation' },
    ]);
    await db.batch(agentHighlightStatements(db, { ...input, executionGeneration: 2 }));
    expect((await db.prepare('SELECT quote FROM message_highlights').all()).results).toEqual([]);
  } finally {
    db.close();
  }
});
