import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { sqliteD1Binding } from '../../agent/memory/tests/d1-test-binding';
import { openSqliteDatabase } from '../../platform/node/sqlite';
import { applySqliteMigrations } from '../../platform/node/sqlite-migrations';
import type { AppDatabase } from '../database';

const migration = (name: string) =>
  readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
const baseline = migration('0000_baseline.sql');
const upgrade = migration('0001_self_hosting.sql');

it('upgrades existing application data without changing identities or admitted turns', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'walden-upgrade-'));
  const db = openSqliteDatabase(join(directory, 'app.sqlite'));
  try {
    writeFileSync(join(directory, '0000_baseline.sql'), baseline);
    await applySqliteMigrations(db, directory);
    await db.exec(
      "INSERT INTO users VALUES ('owner','subject','now','now',0); INSERT INTO notes(id,owner_id,created_at,updated_at,markdown) VALUES ('note','owner','now','now','preserved')",
    );
    writeFileSync(join(directory, '0001_self_hosting.sql'), upgrade);
    await applySqliteMigrations(db, directory);
    expect(await db.prepare('SELECT id,auth_provider,auth_subject FROM users').first()).toEqual({
      id: 'owner',
      auth_provider: 'clerk',
      auth_subject: 'subject',
    });
    expect(await db.prepare('SELECT markdown FROM notes').first('markdown')).toBe('preserved');
    await db.integrityCheck();
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each(['sqlite', 'd1'])(
  '%s preserves cancellation, branch overlap, identity and replay constraints',
  async (backend) => {
    const directory = mkdtempSync(join(tmpdir(), 'walden-invariants-'));
    const native = openSqliteDatabase(join(directory, 'app.sqlite'));
    const db: AppDatabase =
      backend === 'sqlite' ? native : sqliteD1Binding(join(directory, 'app.sqlite'));
    try {
      await db.exec(baseline + '\n' + upgrade);
      await db.exec(`INSERT INTO users(id,auth_subject,created_at,updated_at) VALUES ('owner','subject','now','now');
      INSERT INTO users(id,auth_provider,auth_subject,created_at,updated_at) VALUES ('default','none','default','now','now');
      INSERT INTO conversations(id,owner_id,last_user_activity_at,expires_at,created_at) VALUES ('chat','owner','now','2999','now');
      INSERT INTO conversation_branches(id,conversation_id,owner_id,created_at) VALUES ('a','chat','owner','now'),('b','chat','owner','now'),('c','chat','owner','now');`);
      await db
        .prepare(
          "INSERT INTO users(id,auth_provider,auth_subject,created_at,updated_at) VALUES ('other','none','subject','now','now')",
        )
        .run();
      await expect(
        db
          .prepare(
            "INSERT INTO users(id,auth_provider,auth_subject,created_at,updated_at) VALUES ('duplicate','none','default','now','now')",
          )
          .run(),
      ).rejects.toThrow();
      const admit = (id: string, request: string, branch: string, source: string) =>
        db
          .prepare(
            "INSERT INTO turns(id,request_id,conversation_id,owner_id,status,created_at,branch_id,source_branch_id) VALUES (?,?,'chat','owner','streaming','now',?,?)",
          )
          .bind(id, request, branch, source)
          .run();
      await db.prepare("INSERT INTO turn_cancellations VALUES ('owner','cancelled','now')").run();
      await expect(admit('cancelled', 'cancelled', 'a', 'a')).rejects.toThrow(
        /cancelled before admission/,
      );
      const attempts = await Promise.allSettled([
        admit('turn', 'request', 'a', 'b'),
        admit('overlap', 'overlap', 'c', 'b'),
      ]);
      expect(attempts.map((attempt) => attempt.status)).toEqual(['fulfilled', 'rejected']);
      await db.prepare("INSERT INTO turn_events VALUES ('turn',0,1,'{}','now')").run();
      await expect(
        db.prepare("INSERT INTO turn_events VALUES ('turn',1,1,'{}','now')").run(),
      ).rejects.toThrow();
      await db.prepare("INSERT INTO turn_events VALUES ('turn',1,2,'{}','now')").run();
      await db.prepare("DELETE FROM users WHERE id='owner'").run();
      expect(await db.prepare('SELECT count(*) AS total FROM turn_events').first()).toEqual({
        total: 0,
      });
      await native.integrityCheck();
    } finally {
      native.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
