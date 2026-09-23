# Database schema and migrations

`apps/api/src/db/schema.ts` is the application schema source. Drizzle Kit generates SQL and snapshots under `apps/api/migrations`. Wrangler applies the SQL to local SQLite or production D1; application queries continue to use the D1 binding directly.

## Change the schema

1. Edit the Drizzle schema.
2. Run `pnpm db:generate` and review the generated SQL and snapshot. If existing rows need conversion before a column is removed, add the backfill SQL before the generated drop statements.
3. Run `pnpm db:check`, then `pnpm db:migrate` for local development.
4. Run `pnpm --filter @walden/api db:migrate:test` for the local end-to-end test database.
5. Test before deploying. For an authorized production release, run `pnpm --filter @walden/api db:migrate:remote` before deploying code that needs the new schema.

Commit the schema, migration SQL, and metadata together. Verify any hand-written backfill against existing rows and a fresh database. Do not use Drizzle push against production. Subsequent changes add incremental migrations; do not squash a live database's migration history again.

## September 2026 reset

The user authorized deleting all local and production D1 data. The former 22 SQL migrations were replaced with one Drizzle-generated `0000_baseline.sql`. This is a fresh-database baseline, not an upgrade script for an existing database. Historical migrations remain available in Git history.

The production binding now uses the `walden` database. Mastra creates its `agent_*` tables itself; they are not part of the application schema or generated migrations. The reset also clears those memory tables. Clerk identities and PostHog data are external services and are not deleted by a D1 reset.

Drizzle generation documentation: https://orm.drizzle.team/docs/drizzle-kit-generate
