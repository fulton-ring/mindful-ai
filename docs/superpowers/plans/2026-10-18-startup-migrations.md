# Consistent startup migrations

User-approved requirement: every app runtime applies pending migrations during startup; split deployments do not require a separate migration job.

- [x] Node: all roles migrate before services/listening; reuse SQLite `BEGIN IMMEDIATE` and PostgreSQL transaction advisory locks. Preserve explicit migration CLI and fail-closed schema validation.
- [x] Cloudflare: bundle canonical migration SQL as Text modules; await initialization before HTTP, cron and Durable Object execution. Honor existing Wrangler history, adopt checksums for legacy entries, and serialize pending DDL through unique ledger inserts in the same atomic D1 batch. Retry concurrent losers only after verifying the winning committed history. Evict failed initialization promises so temporary errors can recover.
- [x] Deployment: remove required Compose/Helm migration jobs and align examples/docs with automatic startup. Explicit administration commands remain available.
- [x] This release: export production D1, restore/validate the backup, manually apply the two pending migrations to the current hosted database, and verify existing account/content records are preserved. Do not deploy the Worker as part of this task.
- [x] Verify fresh, populated, concurrent and failed startup on actual databases/workerd; run full checks, native integration and browser/API provider matrix. Restart local app and preserve original data; commit on `feat/self-hosting`.

## Verification record

Production D1 was exported to a private local backup, restored into a temporary SQLite database and integrity-checked before applying `0001_self_hosting.sql` and `0002_retention_policy.sql`. All existing account/note/conversation/message/turn counts remained unchanged; Wrangler reports no pending migrations. The hosted public configuration endpoint remains healthy. No Worker version was deployed.

`pnpm verify` passed with 697 API, 370 web and 41 domain tests (1,108 total), plus successful typechecks and production builds. `pnpm lint` passed. Direct startup tests exercise real workerd D1 transactions, twelve concurrent initialization attempts, legacy Wrangler adoption, rollback, checksum validation and HTTP/cron/DO retry. Four emitted-Worker startup tests passed, including cold HTTP and DO startup without manually initialized tables. Actual Compose configuration and Helm lint/render checks passed. Final native integration checks passed 133 tests, including PostgreSQL/Valkey, automatic concurrent migration, browser/parser providers and SIGKILL recovery. The full browser/API matrix passed 24 cases with three intentional mixed-policy skips; Cloudflare started from empty D1 without any harness-applied migrations. Compose/Helm checks passed. Independent startup review found no remaining concrete issues. The managed local app remains healthy with OpenRouter, and its original four conversation messages exactly match the stopped backup; SQLite integrity is healthy.
