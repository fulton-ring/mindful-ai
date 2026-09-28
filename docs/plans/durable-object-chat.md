# Plan: chat turns on a Durable Object per conversation

Status: implemented on `feat/conversation-do` (2026-09-27). Replaces the Cloudflare Workflow + D1-polling turn engine. As built, there is one object per turn (`ChatTurn`), not per conversation, because several branches of a conversation can stream at once; see `docs/durable-chat-operations.md`.

## Goal

Keep what the Workflow engine gives us — a reply keeps generating after the browser disconnects, any tab can reconnect and see it continue, Stop works — while removing its costs:

- ~5.5 s before the first token (`queue_ms` measured in production): Workflow scheduling.
- Text arrives in lumps: the Workflow writes chunks to D1 about every 100 ms and the events endpoint polls D1 every 80 ms.
- ~1,700 lines of our own durability machinery (checkpointed model preview, epochs and resets, durable store, polling endpoint).

## What the libraries cover (researched)

| Need | Covered by | Notes |
|---|---|---|
| Client chat state, `UIMessage` rendering, resume on load, stop semantics | AI SDK `useChat` (ai@6) | Its resumable-streams guide is exactly our shape: POST to start, GET to resume (204 = nothing), dedicated stop endpoint. |
| WebSocket chat transport | Nobody (AI SDK has only HTTP transports; `ChatTransport` is transport-agnostic) | Not needed for this plan. |
| Model output as a UI message stream | Mastra + `@mastra/ai-sdk` `toAISdkStream` (already in use) | Mastra has no WebSocket or Durable Object chat support, but runs inside a DO like it runs in our Worker. |
| Resumable stream store (buffer + replay + fan-out) | `resumable-stream` needs Redis; its generic mode buffers in producer memory only | We write a small DO-native store instead (~80 LOC). |
| Everything, including recovery | Cloudflare Agents SDK (`AIChatAgent` / `useAgentChat`) | Rejected: it owns a linear, client-authoritative transcript in DO SQLite, which conflicts with our branches and D1 as the source of truth, and it requires zod 4. Its keep-alive, recovery and chunk-buffer design is the reference to copy. |

## Chosen design (option C)

AI SDK's standard resumable-streams pattern over HTTP/SSE, with a Durable Object per conversation as the stream store and turn runner.

```
Browser ─POST /api/chat/turns──────────► Worker (auth, admission) ─► ConversationDO.start() ─► Mastra ─► model
Browser ─GET  /api/chat/turns/:id/events► Worker (auth) ─► ConversationDO.stream(after)  (replay buffer, then live)
Browser ─POST /api/chat/turns/:id/cancel► Worker (auth) ─► ConversationDO.stop()
                                           ConversationDO ─► D1 (final UIMessage, turn status)
```

### ConversationDO (new, ~250–320 LOC)

- One object per conversation: `env.CONVERSATION.idFromName(conversationId)`.
- `start(turn)`: runs the Mastra turn **detached** from the request that started it (the HTTP response is only a subscriber). Converts output with `toAISdkStream` (v6), appends each chunk to an in-memory buffer and to DO SQLite with a sequence number (batched writes), and fans out to subscribers.
- `stream(after)`: returns an SSE response that replays chunks after `after`, then follows live chunks; one writer per open GET, so several tabs work.
- `stop()`: aborts the turn's `AbortController`, persists the partial reply as interrupted.
- Keep-alive: an alarm roughly every 30 s while a turn runs (a DO is evicted 70–140 s after its last incoming event, and outgoing model fetches do not keep it alive; `waitUntil` has no effect in DOs).
- Recovery: on wake or alarm, a turn left running by a restart or deploy is sealed as interrupted with its buffered partial (decision below).
- Finish: builds the final `UIMessage` from the buffer with `readUIMessageStream`, writes it to D1 with the same branch/head fencing as today, deletes the chunk buffer.
- One turn at a time per conversation comes from the object; the D1 triggers stay as a backstop at first.

### Worker routes (~50 LOC changed)

`POST /turns` keeps admission (branching, message limit, user message) and then calls `stub.start()` instead of creating a Workflow. `GET /turns/:id/events` and `POST /turns/:id/cancel` forward to the object. Auth stays a normal `Authorization` header.

### Client (~0–40 LOC changed)

Keep `useChat` and `DurableTurnTransport` (already POST + resume GET + stop). Remove the reset/epoch handling. Add a focus/visibility re-check of `GET /turns` so an already-open idle tab notices a turn started in another tab.

## Removed

`chat/turns/workflow.ts`, `workflow-runner.ts`, `durable-store.ts`, `event-stream.ts` (replaced by the DO stream), `scheduling.ts`; `agent/checkpoints.ts`, `agent/model-preview.ts`; the `workflows` block in `wrangler.jsonc`; the D1 `turn_events` table and epoch columns; the minute cron's turn reconciliation; tests `durable-store.test.ts`, `event-stream.test.ts`, `retry-incomplete.test.ts` (rewritten against the DO). About 1,700 lines.

Kept: `turn-lifecycle.ts` (admission), `message-limit.ts`, `turn-support.ts`, `mastra-turn.ts`, `ui-stream.ts`, memory, all of D1's conversation/message/branch model.

## Trade-off accepted

The Workflow retried failed steps and survived deploys mid-turn. A DO restarts on deploy and does not retry: a reply interrupted by a deploy or crash ends as interrupted (with its partial text and a Try again button), the way most chat products behave.

## Spikes before building (in order)

1. **Detached turn survives tab close.** A proxied DO SSE response: close the tab mid-reply; generation finishes and reaches D1. Confirm the Worker does not buffer the proxied SSE.
2. **Alarm heartbeat prevents eviction** during a model call longer than 3 minutes with no tabs open.
3. **Deploy mid-turn.** The recovery path seals the turn as interrupted with its partial.
4. **Testing setup.** `@cloudflare/vitest-pool-workers` 0.12.x (last for vitest 3.2) with our 2026-09-18 compatibility date, or move to vitest 4.
5. **Latency.** Time to first token and streaming smoothness against the current production numbers.

## Phases

1. Spikes 1–3 on a branch with a minimal `ConversationDO` (no persistence polish).
2. Build the DO fully; switch `POST /turns`, events and cancel to it behind the same API; keep the Workflow code until the DO path passes the test suite.
3. Delete the Workflow engine, its tables and tests; migration dropping `turn_events` and epoch columns.
4. Local verification in the browser (two tabs, tab close, Stop, reload mid-reply, regenerate/branches), then deploy.

## Decisions

- **Interrupted by a deploy or crash:** sealed as interrupted with the partial reply; no automatic re-run.
- **Live push to already-open idle tabs:** not required. A tab re-checks for a running turn when it regains focus.

## Spike results (2026-09-27, throwaway Worker, deleted afterwards)

1. Tab close: the run continued after the SSE client disconnected, and SSE proxied through the Worker streamed live, unbuffered.
2. Eviction: without an alarm the object was evicted 60–85 s after its last request; with a 30 s alarm it ran a 5-minute turn to the end.
3. Deploy mid-turn: the run died, and the next alarm on the new version sealed it as interrupted within 30 s.
4. Testing: not needed. The object's logic lives in `TurnSession`, which the existing Node tests drive with in-memory storage.
