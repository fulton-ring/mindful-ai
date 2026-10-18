import { expect, it } from 'vitest';
import { chargeMessage, loadMessageBudget } from '../message-limit';
import { prepareTurn } from '../turn-lifecycle';
import { turnFixture } from './turn-fixture';

const request = (requestId: string) => ({
  requestId,
  conversationId: 'conversation',
  branchId: 'branch',
  noteRevision: null,
  message: 'Weighted admission',
  personaId: 'thinking-partner',
  action: 'message' as const,
});

it.each([10, null])(
  'refunds weighted usage after failed admission with a %s point policy',
  async (limit) => {
    const db = await turnFixture();
    await db.prepare("UPDATE turns SET status='completed'").run();
    await db.exec(`CREATE TRIGGER reject_fixture_admission BEFORE INSERT ON turns
    WHEN NEW.request_id='reject' BEGIN SELECT RAISE(ABORT,'Fixture admission failure'); END;`);
    await db.exec(`CREATE TABLE quota_audit(used INTEGER);
    CREATE TRIGGER audit_quota_write AFTER UPDATE ON message_windows
    BEGIN INSERT INTO quota_audit(used) VALUES(NEW.used); END;`);
    const messageLimit = { limit, windowHours: 4 };
    await chargeMessage(db, 'owner', messageLimit, 2);
    await expect(
      prepareTurn(
        { db, ownerId: 'owner', messageLimit, modelFor: () => 'weighted', modelWeightFor: () => 3 },
        request('reject'),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await loadMessageBudget(db, 'owner', messageLimit)).used).toBe(2);
    expect((await db.prepare('SELECT used FROM quota_audit ORDER BY rowid').all()).results).toEqual(
      [{ used: 5 }, { used: 2 }],
    );
    expect(await db.prepare("SELECT id FROM turns WHERE request_id='reject'").first()).toBeFalsy();
  },
);

it('charges unlimited admission once and preserves usage when a finite plan is selected again', async () => {
  const db = await turnFixture();
  await db.prepare("UPDATE turns SET status='completed'").run();
  const runtime = {
    db,
    ownerId: 'owner',
    messageLimit: { limit: null, windowHours: 4 },
    modelFor: () => 'weighted',
    modelWeightFor: () => 3,
  };
  expect((await prepareTurn(runtime, request('admitted'))).kind).toBe('stream');
  await db.prepare("UPDATE turns SET status='completed'").run();
  expect((await prepareTurn(runtime, request('admitted'))).kind).toBe('replay');
  expect((await loadMessageBudget(db, 'owner', runtime.messageLimit)).used).toBe(3);
  await expect(
    prepareTurn({ ...runtime, messageLimit: { limit: 4, windowHours: 4 } }, request('blocked')),
  ).rejects.toMatchObject({ status: 429 });
  expect((await loadMessageBudget(db, 'owner', runtime.messageLimit)).used).toBe(3);
  expect(
    (
      await prepareTurn(
        { ...runtime, messageLimit: { limit: 6, windowHours: 4 } },
        request('upgrade'),
      )
    ).kind,
  ).toBe('stream');
  expect((await loadMessageBudget(db, 'owner', runtime.messageLimit)).used).toBe(6);
});
