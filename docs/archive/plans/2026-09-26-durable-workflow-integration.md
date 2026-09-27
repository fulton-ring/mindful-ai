# Durable Chat Workflow Integration Plan

**Goal:** Integrate the proven Cloudflare Workflow execution from `feat/durable-chat-wip` into the current Walden application while preserving live text, current chat behavior, attachments, and the Drizzle schema.

**Architecture:** The API admits an idempotent turn, a Cloudflare Workflow owns generation, and D1 stores ordered progress for authenticated replay. The browser observes a turn through a cursor and may detach without cancelling it. Explicit Stop, deletion, and expiry cancel execution. Reuse the branch's checkpoint and fencing logic, but adapt it to the current modular code; do not merge its old route, UI, or SQL files wholesale.

**Tech stack:** Cloudflare Workers and Workflows, D1 and Drizzle, Mastra, AI SDK, React, Vitest, Wrangler.

## Starting point and integration constraints

The branch contains a working local implementation and a deployed recovery spike. Its app changes predate the baseline Drizzle migration, current `chat/turns/*` modules, R2 workspace uploads, per-persona models, and new analytics. In particular, its `0020` and `0021` SQL migrations cannot be applied to the current migration history. Its old `ChatPanel.tsx` and `chat/routes.ts` cannot replace the current versions without losing features. The branch already has live provisional model text in `agent/checkpoints.ts`; keep that behavior and make replay replace an interrupted attempt's provisional text.

## File map

- `apps/api/src/db/schema.ts` and generated `apps/api/migrations/*`: durable turn input, execution epoch, progress events, cancellation intents, and branch overlap constraints.
- `apps/api/src/chat/turns/durable-store.ts`: admission, ordered event persistence, terminal commit, and execution fencing adapted from the branch's `durable-turns.ts`.
- `apps/api/src/chat/turns/workflow.ts`, `scheduling.ts`, and `apps/api/src/worker.ts`: Workflow execution, reconciliation, cron, and Worker entry point adapted from the branch.
- `apps/api/src/chat/turns/routes.ts`, `turn-lifecycle.ts`, and `turn-stream.ts`: authenticated start/status/events/Stop API; remove request-owned execution only after replacement works.
- `apps/api/src/agent/checkpoints.ts` and current `agent/mastra-turn.ts`: checkpoint model and tool steps while preserving current model, workspace, search, note, and learning-check capabilities.
- `packages/contracts/src/index.ts` and `apps/web/src/lib/api.ts`: admission and replay protocol, cursor, and attempt-aware progress.
- `apps/web/src/features/chat/panel/hooks/actions/use-chat-send.ts`, `use-chat-regenerate.ts`, `use-chat-lifecycle.ts`, and `hooks/state/use-chat-turn.ts`: attach, detach, reconnect, and explicit cancellation.
- `apps/api/src/observability.ts`, `apps/web/src/lib/telemetry.ts`, and `docs/analytics.md`: lifecycle and recovery metrics without user content.

## Tasks

### 1. Revalidate the branch against current dependencies

- [ ] Read `feat/durable-chat-wip`'s `docs/durable-chat-design.md`, `docs/durable-chat-operations.md`, `apps/api/spikes/durable-chat/README.md`, `agent/checkpoints.ts`, `chat/workflow.ts`, `chat/durable-turns.ts`, and `chat/scheduling.ts`.
- [ ] In an isolated worktree, verify current Wrangler's Workflow binding, `WorkflowEntrypoint`, `WorkflowStep.do`, instance status/terminate, and local emulator behavior against installed types and current Cloudflare documentation.
- [ ] Write a short compatibility note for behavior that changed since the spike, especially checkpoint result size, retry policy, live preview, and cancellation. Keep the spike as reference rather than copying its demo Worker into the app.

### 2. Add durable state through Drizzle

- [ ] Extend `apps/api/src/db/schema.ts` with immutable turn input/request, source branch, execution epoch, ordered `turn_events`, and cancellation intent. Generate a new migration after current `0002`; do not import old `0020` or `0021` files.
- [ ] Add a migration that marks existing `streaming` turns failed before enabling Workflow ownership. Preserve current users, notes, attachments, and completed conversations.
- [ ] Add D1 tests for duplicate admission, overlapping source/target branches, event order and replay, ownership, terminal idempotency, stale-epoch rejection, and cascade deletion.

### 3. Separate execution from HTTP and preserve live text

- [ ] Adapt branch checkpointed model/tool execution into the current Mastra service. Keep GLM/Gemma persona selection, R2 workspace, document tools, web search, learning checks, and note proposal behavior.
- [ ] Persist provisional text in bounded, numbered events while the provider streams. Include attempt identity; when a provider attempt retries, supersede its provisional text instead of appending duplicates. Checkpoint the successful model response for Mastra replay.
- [ ] Move final message, usage accounting, and terminal status into a fenced, idempotent commit. A cancelled or replaced epoch cannot commit. Add tests that interrupt model and tool steps and verify no duplicate assistant messages, tool effects, or usage.
- [ ] Keep raw prompts, document text, and provider errors out of diagnostic logs and PostHog events; durable D1 progress remains application data and follows conversation retention.

### 4. Add Workflow admission, replay, and cancellation endpoints

- [ ] Add `ChatWorkflow` and `CHAT_WORKFLOW` to the API Worker and Wrangler configs; add a minute reconciliation cron alongside the existing hourly retention cron.
- [ ] Make POST turn admission idempotent by request ID and immutable payload; return `turnId`. Add authenticated status and `/events?after=<seq>` endpoints with bounded observer lifetime and ordered SSE IDs.
- [ ] Stop must persist intent before terminating Workflow. Disconnect must not cancel. Reconcile accepted-but-unscheduled turns and terminal Workflow failures.
- [ ] Test two-tab admission races, owner isolation, cursor replay after disconnect, Stop during provider generation and final commit, deletion/expiry, and reconciliation.

### 5. Adapt the current client without losing features

- [ ] Add admission and attach APIs to `apps/web/src/lib/api.ts`; retry transport errors with the same request ID and last event cursor. Keep user-visible failures separate from reconnecting state.
- [ ] Update the current panel hooks to discover an active turn when reopening a conversation, attach on navigation/reload, and detach on unmount. Only the Stop button sends cancellation.
- [ ] Preserve current attachment upload gating, note proposals, highlights, quiz UI, regeneration, branch edits, personas, and analytics. Test each around reconnection and out-of-order replay.
- [ ] Add browser tests for a long streamed answer, refresh mid-answer, another tab attaching, offline/reconnect, Stop, and revisiting a completed thread. Verify streamed text appears before generation finishes.

### 6. Verify and release in stages

- [ ] Run focused D1/Workflow and client tests, `pnpm verify`, `pnpm lint`, `pnpm db:check`, and `git diff --check` in the integration worktree.
- [ ] Run `pnpm dev` and browser-test a response over five minutes, disconnect for at least 30 seconds, refresh, Stop, search, file reading, note proposals, highlights, branch edit, and regeneration. Inspect D1 status and Workflow status after each.
- [ ] Add `chat_turn_started`, `chat_turn_recovered`, and `chat_turn_terminal` bounded server metrics; correlate with browser `chat_failed` using `turn_id`. Confirm no message, note, or file content enters analytics.
- [ ] Prepare production migration, matching API/web deploy, and rollback steps. Deploy only after the live-stream and recovery gates pass; run a production smoke test before declaring durability enabled.

## Release gates

1. Text appears during provider streaming, before the Workflow step completes.
2. Network loss or tab closure never cancels a healthy turn; reconnect shows the same turn and no duplicate text.
3. Explicit Stop, deletion, and expiry prevent later commits.
4. Current note, search, upload, persona, quiz, and branch flows behave as before.
5. D1 and Workflow terminal states agree, and failures have bounded reason codes without user content.
