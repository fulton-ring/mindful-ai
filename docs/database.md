# Database schema and migrations

`apps/api/src/db/schema.ts` is the application schema source. Drizzle Kit generates SQL and snapshots under `apps/api/migrations`. Application startup applies pending migrations before serving requests, execution or scheduled work. SQLite and PostgreSQL serialize startup migrations with database locks; Cloudflare D1 uses atomic batches and unique migration ledger entries. Application queries continue to use the database adapter directly.

## Change the schema

1. Edit the Drizzle schema.
2. Run `pnpm db:generate` and review the generated SQL and snapshot. If existing rows need conversion before a column is removed, add the backfill SQL before the generated drop statements.
3. Run `pnpm db:check`, then start the app against a disposable database to verify automatic migration. Wrangler's `pnpm db:migrate` remains available for explicit local administration.
4. Test both fresh startup and an upgrade from a populated database, including concurrent startup and failed-migration rollback. D1's canonical migration list in the startup runner must include each generated SQL file; preserve the `--> statement-breakpoint` separators so complete triggers remain single statements.
5. Back up production before deploying a schema change. Startup waits for migrations to finish and refuses traffic when they fail. Manual `pnpm --filter @walden/api db:migrate:remote` remains an operator recovery tool; it is not a deployment prerequisite.

Commit the schema, migration SQL, and metadata together. Verify any hand-written backfill against existing rows and a fresh database. Do not use Drizzle push against production. Subsequent changes add incremental migrations; do not squash a live database's migration history again.

## Hand-written SQL

`0000_baseline.sql` ends with two triggers on `turns` that Drizzle Kit cannot generate: `prevent_cancelled_turn_admission` and `prevent_overlapping_turn_branches`. If the baseline is ever regenerated, copy them back in. A migration that rebuilds the `turns` table must recreate them.

## Baseline resets

The user authorized deleting all local and production D1 data three times in September 2026. Each time, the migration history was replaced with one Drizzle-generated `0000_baseline.sql`. This is a fresh-database baseline, not an upgrade script for an existing database. Historical migrations remain available in Git history.

Those resets were historical, explicitly authorized data deletions. Existing databases record `0000_baseline.sql` as applied, and startup honors that history instead of replaying the baseline. Normal upgrades add new migration files and preserve data. Do not reset or recreate a populated database to apply an upgrade.

The second reset also simplified the schema: it dropped write-only columns (`turns.input_tokens`/`output_tokens`, `note_edits.undone_at`, `note_suggestions.decided_at`, `conversation_branches.last_user_activity_at`, `conversations.persona_snapshot_json`, `usage_periods.unit_limit`), made always-set branch and suggestion keys `NOT NULL`, added indexes for owner and foreign-key lookups, removed duplicate indexes, and added `IN (0,1)` checks to boolean columns. The third, with the move from Workflows to Durable Objects, dropped the `turn_events` table and `turns.execution_epoch`.

The production binding uses the `walden` database. Mastra creates its `agent_*` tables itself; they are not part of the application schema or generated migrations. A reset also clears those memory tables. Clerk identities and PostHog data are external services and are not deleted by a D1 reset.

Drizzle generation documentation: https://orm.drizzle.team/docs/drizzle-kit-generate
