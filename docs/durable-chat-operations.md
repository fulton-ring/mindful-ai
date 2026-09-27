# Durable chat operations

Chat admission returns a turn ID. Cloudflare Workflow generates the answer, and D1 stores ordered events for `/api/chat/turns/:id/events?after=<seq>`. Closing a tab only detaches the observer. Stop records cancellation in D1 and terminates the Workflow. The minute cron retries scheduling admitted turns; the hourly cron still handles conversation retention.

## Local checks

1. Run `pnpm --filter @walden/api db:migrate`, then restart `pnpm dev` so the Worker loads the `CHAT_WORKFLOW` binding.
   The Vite UI on port 5173 proxies `/api` to port 8787. `dev:test` normally uses port 8788; if a test-config Worker is run on 8787, it must include the Workflow binding too. Wrangler is required locally because it supplies the D1 and Workflow emulators.
2. Send a long prompt. Confirm text appears while Stop is available.
3. Leave the thread, open it in another tab, refresh, and confirm there is one response that continues or finishes.
4. Stop a turn and check that its D1 `turns.status` is `cancelled`; no completed assistant message may be added afterward.
5. Simulate a lost event connection and confirm the next `/events` request uses the last received sequence number. The client must not send `/cancel` for a disconnected observer.

Run `pnpm verify`, `pnpm lint`, `pnpm db:check`, and `git diff --check` before release. Wrangler's dry-run build checks the Workflow binding and Worker bundle.

## Production rollout

Apply D1 migrations with `pnpm --filter @walden/api db:migrate:remote` before deploying the Worker, and deploy the API and bundled web assets together. `turns`, `turn_events` and `turn_cancellations` hold active turn state; the schema is in `0000_baseline.sql` (see `docs/database.md`).

After deployment, smoke-test a long answer, tab closure and reattachment, Stop, file reading, note proposals, and search. Compare D1 `turns.status` with Workflow instance status for the same turn ID. PostHog records `chat_turn_started`, `chat_turn_recovered`, and `chat_turn_terminal` with bounded IDs and status only. If admission fails, check the Workflow binding and minute reconciliation logs. If replay fails, inspect `turn_events` sequence and the authenticated events endpoint. Events of finished turns are pruned a day after completion.

If rollback is needed, first stop new admissions, let active Workflows finish or cancel them, then restore the previous Worker version. The schema can remain in place. Do not restore a pre-migration D1 snapshot unless the lost conversations and notes are acceptable.
