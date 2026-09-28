# Database schema and migrations

`apps/api/src/db/schema.ts` is the application schema source. Drizzle Kit generates SQL and snapshots under `apps/api/migrations`. Wrangler applies the SQL to local SQLite or production D1; application queries continue to use the D1 binding directly.

## Change the schema

1. Edit the Drizzle schema.
2. Run `pnpm db:generate` and review the generated SQL and snapshot. If existing rows need conversion before a column is removed, add the backfill SQL before the generated drop statements.
3. Run `pnpm db:check`, then `pnpm db:migrate` for local development.
4. Run `pnpm --filter @walden/api db:migrate:test` for the local end-to-end test database.
5. Test before deploying. For an authorized production release, run `pnpm --filter @walden/api db:migrate:remote` before deploying code that needs the new schema.

Commit the schema, migration SQL, and metadata together. Verify any hand-written backfill against existing rows and a fresh database. Do not use Drizzle push against production. Subsequent changes add incremental migrations; do not squash a live database's migration history again.

## Hand-written SQL

`0000_baseline.sql` ends with two triggers on `turns` that Drizzle Kit cannot generate: `prevent_cancelled_turn_admission` and `prevent_overlapping_turn_branches`. If the baseline is ever regenerated, copy them back in. A migration that rebuilds the `turns` table must recreate them.

## Baseline resets

The user authorized deleting all local and production D1 data three times in September 2026. Each time, the migration history was replaced with one Drizzle-generated `0000_baseline.sql`. This is a fresh-database baseline, not an upgrade script for an existing database. Historical migrations remain available in Git history.

Because the file name stays the same, an existing database already records `0000_baseline.sql` as applied. Reset it before migrating: delete `apps/api/.wrangler/state/v3/d1` for local and test databases, and recreate the production database (or drop its tables and `d1_migrations`) before running `db:migrate:remote`.

The second reset also simplified the schema: it dropped write-only columns (`turns.input_tokens`/`output_tokens`, `note_edits.undone_at`, `note_suggestions.decided_at`, `conversation_branches.last_user_activity_at`, `conversations.persona_snapshot_json`, `usage_periods.unit_limit`), made always-set branch and suggestion keys `NOT NULL`, added indexes for owner and foreign-key lookups, removed duplicate indexes, and added `IN (0,1)` checks to boolean columns. The third, with the move from Workflows to Durable Objects, dropped the `turn_events` table and `turns.execution_epoch`.

The production binding uses the `walden` database. Mastra creates its `agent_*` tables itself; they are not part of the application schema or generated migrations. A reset also clears those memory tables. Clerk identities and PostHog data are external services and are not deleted by a D1 reset.

Drizzle generation documentation: https://orm.drizzle.team/docs/drizzle-kit-generate
