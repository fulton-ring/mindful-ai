# Durable chat operations

Chat admission returns a turn ID and starts the turn in its own Durable Object (`ChatTurn`, keyed by turn ID). The object runs the agent detached from any request, keeps the turn's UI message chunks in memory and in its SQLite storage, and streams them to every reader of `/api/chat/turns/:id/events?after=<seq>`, replaying from the cursor and then following live. Closing a tab only detaches that reader. Stop aborts the run; what streamed is kept as an interrupted reply. When the run ends, the object writes the reply to D1 and keeps its chunks for an hour so late readers can finish replaying.

An object is evicted about a minute after its last incoming request, and a model call does not count, so a running turn sets an alarm every 30 seconds to stay alive. A deploy or restart ends the run: the next alarm, reader, or Stop finds the turn stored as running but not running there, and seals it as interrupted with what it had streamed. There is no automatic retry. The minute cron starts admitted turns an object never received and fails turns that never finished admission; the hourly cron still handles conversation retention.

A tab only learns of a turn it did not start (another tab or device) when the conversation opens or the tab regains focus.

## Local checks

1. Run `pnpm --filter @walden/api db:migrate`, then restart `pnpm dev` so the Worker loads the `CHAT_TURN` binding.
   The Vite UI on port 5173 proxies `/api` to port 8787. `dev:test` normally uses port 8788; if a test-config Worker is run on 8787, it must include the Durable Object binding too. Wrangler is required locally because it supplies the D1 and Durable Object emulators.
2. Send a long prompt. Confirm text appears while Stop is available.
3. Leave the thread, open it in another tab, refresh, and confirm there is one response that continues or finishes.
4. Stop a turn and check that its D1 `turns.status` is `cancelled`; no completed assistant message may be added afterward.
5. Simulate a lost event connection and confirm the next `/events` request uses the last received sequence number. The client must not send `/cancel` for a disconnected observer.

Run `pnpm verify`, `pnpm lint`, `pnpm db:check`, and `git diff --check` before release. Wrangler's dry-run build checks the Durable Object binding and Worker bundle.

## Message limit

Each account has an anchored message window. Its first message opens a window of `MESSAGE_WINDOW_HOURS` (default 4); every send, regenerate, and edit spends its model's `weight` (from `PERSONA_MODELS` in `packages/contracts`) out of `MESSAGE_LIMIT` (default 20), and the whole budget comes back when the window ends. `message_windows` holds each account's window start and spend. Admission charges atomically after every other check and refunds if the turn is not admitted, so replays and refused turns cost nothing, and deleting threads does not return spend. Over the limit, `POST /api/chat/turns` returns 429 with `details.retryAt`, and the composer keeps the unsent draft. Once the reply that used up the budget finishes (or what is left cannot pay for the selected persona's model), the composer says so, with the reset time, and disables the input until the window resets; `POST /api/chat/turns` returns the budget after its charge, and `GET /api/budget` reads it. Settings → Usage shows the remaining budget and the reset time. Both values are Worker vars in `wrangler.jsonc`, so changing them needs only a redeploy. Each turn also records its `model` and `weight`.

## Production rollout

Apply D1 migrations with `pnpm --filter @walden/api db:migrate:remote` before deploying the Worker, and deploy the API and bundled web assets together. `turns` and `turn_cancellations` hold turn state in D1; a running turn's chunks live only in its object. The schema is in `apps/api/migrations` (see `docs/database.md`).

After deployment, smoke-test a long answer, tab closure and reattachment, Stop, file reading, note proposals, and search. PostHog records `chat_turn_started` and `chat_turn_terminal` with bounded IDs and status only. If admission fails, check the Durable Object binding and minute reconciliation logs. If replay fails, check the authenticated events endpoint; a finished turn's chunks are cleared an hour after it ends, after which the endpoint answers 204 and the reply loads from D1.

If rollback is needed, restore the previous Worker version; running turns end as interrupted, as with any deploy. Versions from before the Durable Object engine used a Workflow and a `turn_events` table that the current baseline no longer creates, so they cannot be restored against this schema. Do not restore a pre-migration D1 snapshot unless the lost conversations and notes are acceptable.
