# Thread Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Regenerating any completed assistant response creates a selectable conversation branch while preserving the original response and every downstream message.

**Architecture:** Keep one conversation as the ownership, note, and title container. Store messages as a parent-linked tree and store each selectable branch as a named head into that tree; shared ancestors keep their original message IDs and exist only once. Turns, interventions, suggestions, memory threads, and cancellation are scoped by `branchId`. Retention is seven days of whole-thread inactivity.

**Tech Stack:** Cloudflare D1/SQLite, Hono, Mastra memory, React, TanStack Router, Zod, Vitest.

---

## Product behavior

- Regenerate remains an action on a completed assistant message. If that message is the selected branch head, regeneration creates a sibling assistant under the same user message. If it is older, regeneration creates a branch at that point and leaves the selected branch unchanged until the new response completes.
- The original assistant and its downstream messages are never updated or deleted. The generated assistant gets a new message ID and becomes the head of a new branch.
- A branch selector appears only when a fork has siblings. Selecting a branch changes the URL and loads that branch's ancestor path. Browser back/forward therefore restores the selected branch.
- All branches use the conversation's single attached note. Note edits and note revision conflicts retain the current behavior.
- Branches share the conversation's seven-day inactivity window. Activity on any branch renews the whole thread.

## Minimal data model

Create `apps/api/migrations/0010_thread_branches.sql`.

```sql
CREATE TABLE conversation_branches (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  head_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  forked_from_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  last_user_activity_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_default_conversation_branch
  ON conversation_branches(conversation_id) WHERE is_default=1;
CREATE INDEX conversation_branches_expiry
  ON conversation_branches(status, expires_at);

ALTER TABLE messages ADD COLUMN parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN origin_branch_id TEXT REFERENCES conversation_branches(id) ON DELETE SET NULL;
ALTER TABLE turns ADD COLUMN branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE;
ALTER TABLE interventions ADD COLUMN branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE;
ALTER TABLE note_suggestions ADD COLUMN branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE;

DROP INDEX one_streaming_turn;
DROP INDEX one_pending_intervention;
CREATE UNIQUE INDEX one_streaming_turn_per_branch
  ON turns(branch_id) WHERE status='streaming';
CREATE UNIQUE INDEX one_pending_intervention_per_branch
  ON interventions(branch_id) WHERE status='pending';
CREATE UNIQUE INDEX one_suggestion_per_branch_source
  ON note_suggestions(owner_id, conversation_id, branch_id, source_message_id);
```

Migration order matters because branches reference messages and messages reference branches:

1. Add the nullable columns.
2. Insert one default branch per conversation, copying the conversation activity and expiry timestamps.
3. Backfill each existing message's `parent_message_id` from the preceding sequence and set `origin_branch_id` to the default branch.
4. Set each default branch head to its conversation's last message.
5. Backfill turns, interventions, and suggestions to the default branch.
6. Rebuild the affected tables to make branch columns non-null and remove `note_suggestions`' old `UNIQUE(owner_id, conversation_id, source_message_id)` constraint before adding its branch-scoped replacement. Preserve the existing globally increasing message `sequence`; it remains a stable tie-breaker, while `parent_message_id` defines transcript membership.

Do not copy shared-prefix messages into a new branch. Copying would change source IDs, duplicate annotations, and complicate suggestion attribution.

## API and contract shape

Add `branchId` to `Conversation` and `ChatRequest`. Add a compact branch descriptor to the loaded conversation:

```ts
type ConversationBranch = {
  id: string;
  forkedFromMessageId: string | null;
  headMessageId: string | null;
  expiresAt: string;
};

type Conversation = {
  // existing fields
  branchId: string;
  branches: ConversationBranch[];
};
```

Use the existing route with a query parameter:

```text
GET /api/conversations/:conversationId?branch=:branchId
```

Omitting `branch` selects the default branch. An unknown, foreign, or expired branch returns `404` or `410` using the same ownership and expiry rules as conversations. The web route is:

```text
/conversations/:conversationId?branch=:branchId
```

The default branch may omit the query parameter for short stable links. Selecting any non-default branch writes `branch` through TanStack Router rather than component-only state.

`loadConversation` should load the owned branch row, then reconstruct only its path with a recursive CTE from `head_message_id` through `parent_message_id`. Return messages oldest-first. All mutation and follow-up requests must include `branchId`; the server verifies that every target message lies on that branch's reconstructed path.

## Regeneration transaction

Replace the current latest-only `regenerationContext` and in-place `REGENERATE_ASSISTANT_SQL` behavior.

1. Load the requested branch and verify the target is a completed assistant on its path with a user parent.
2. Reject if that branch is expired or already has a streaming turn.
3. Insert a new branch with `forked_from_message_id` equal to the original assistant ID and a temporary head equal to the parent user ID.
4. Insert the streaming turn with the new `branch_id`. Generate from the path ending immediately before the parent user, using that user's unchanged content as the prompt.
5. On completion, insert a new assistant message with a new ID, `parent_message_id` equal to the parent user ID, and `origin_branch_id` equal to the new branch. Update the new branch head to that message and complete the turn in the same D1 batch.
6. Emit the existing `done` event plus `branchId`. The client navigates to the new branch only after this durable completion.

The completion batch must require both the turn to remain `streaming` and the new branch to remain `active`. It must never update the original assistant row. A retry with the same `(owner_id, request_id)` replays the completed assistant and its branch ID.

## Continuing a branch

For an ordinary message, insert the user message with `parent_message_id` equal to the selected branch head and `origin_branch_id` equal to the selected branch. Insert the assistant as its child, then advance that branch head in the same completion batch. The original branch and sibling branches do not move.

Pending interventions are queried and superseded by `branch_id`. Annotation and note-proposal follow-ups require the selected `branchId` and verify the source message is on its path. Suggestions retain the real `source_message_id`; the added `branch_id` prevents one branch's accepted, dismissed, or pending decision from suppressing a sibling branch's suggestion.

## Memory, expiry, and deletion

Use one Mastra thread per branch:

```ts
threadId = `conversation:${ownerId}:${conversationId}:branch:${branchId}`;
resourceId = `user:${ownerId}`;
```

`prepareAgentMemory` receives the selected branch transcript only. Regenerating creates a fresh memory thread from the shared path plus the new assistant; it does not clear or rewrite the source branch's memory. Observational memory is therefore isolated by branch automatically.

The conversation owns the seven-day inactivity window. Any user action on any branch renews the conversation and copies the same expiry to every active branch descriptor. At thread expiry, clear every branch memory thread and all transcript state together while preserving an attached note under the existing retention behavior. Explicit conversation deletion still removes every branch and the shared note follows the existing note ownership rules. A cancelled regeneration branch is marked expired immediately and never becomes the default branch.

## Cancellation and concurrency

- Change the active-turn registry key to include `branchId`; `abortActiveTurn` targets a turn, branch deletion aborts turns for that branch, and conversation deletion aborts all branches.
- The one-streaming-turn constraint moves from conversation to branch. Separate branches may stream concurrently without sharing controllers, optimistic messages, or follow-up state.
- If regeneration is cancelled before completion, mark its turn cancelled and the new branch expired, clear its memory, and do not navigate. If partial assistant text is retained, store it as incomplete on the new branch only.
- Guard completion with `WHERE branch.status='active'` and `turn.status='streaming'`. If either update reports zero changes, emit no `done` event.
- A late follow-up checks branch membership, source existence, and branch expiry immediately before persisting, mirroring the current note revision rebase.

## Implementation sequence

### Task 1: Schema and path loading

**Files:** `apps/api/migrations/0010_thread_branches.sql`, `apps/api/src/migrations.test.ts`, `apps/api/src/chat/conversations.ts`, `apps/api/src/chat/conversations.test.ts`, `packages/contracts/src/index.ts`

- [ ] Add a migration test that proves one default branch is created per existing conversation, parent links reproduce the original transcript, and existing turns/interventions/suggestions point to that branch.
- [ ] Apply the schema above and replace conversation-wide streaming/pending unique indexes with branch-scoped indexes.
- [ ] Add contract fields and implement owned branch selection plus recursive path loading.
- [ ] Test default selection, explicit selection, foreign branch rejection, and expired branch rejection.
- [ ] Run `pnpm --filter @walden/api exec vitest run src/migrations.test.ts src/chat/conversations.test.ts` and `pnpm --filter @walden/api typecheck`.

### Task 2: Branch creation and branch continuation

**Files:** `apps/api/src/chat/routes.ts`, `apps/api/src/chat/routes.test.ts`, `apps/api/src/chat/active-turns.ts`, `apps/api/src/chat/cancellation.test.ts`

- [ ] Write failing tests proving regeneration of an older assistant preserves the original rows and downstream path, creates a sibling assistant with a new ID, and returns a new branch ID.
- [ ] Replace latest-only/in-place regeneration with the six-step transaction above.
- [ ] Scope ordinary turns, replay, orphan recovery, interventions, and active-turn checks to the selected branch.
- [ ] Test simultaneous turns on sibling branches, cancellation before completion, completion racing branch expiry, and idempotent request replay.
- [ ] Run `pnpm --filter @walden/api exec vitest run src/chat/routes.test.ts src/chat/cancellation.test.ts`.

### Task 3: Branch-scoped memory and follow-ups

**Files:** `apps/api/src/agent/memory.ts`, `apps/api/src/agent/memory.test.ts`, `apps/api/src/chat/followups.ts`, `apps/api/src/chat/followups.test.ts`, `apps/api/src/notes/suggestions.ts`

- [ ] Test that sibling branches write distinct Mastra thread IDs while sharing the resource ID.
- [ ] Pass `branchId` through memory preparation/deletion and reconcile only the selected path.
- [ ] Require branch membership for annotations and note proposals; persist suggestion `branch_id` while keeping the original source message ID.
- [ ] Test that sibling branches can hold independent pending suggestions for a shared source message and that current-note rebasing still rejects overlapping edits.
- [ ] Run the focused memory and follow-up suites plus API typecheck.

### Task 4: URL selection and branch UI

**Files:** `apps/web/src/App.tsx`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/api.test.ts`, `apps/web/src/features/chat/ChatPanel.tsx`, `apps/web/src/features/chat/ChatPanel.test.tsx`

- [ ] Test that loading `?branch=<id>` requests that branch and browser navigation switches transcripts.
- [ ] Send `branchId` with turns and follow-ups. Keep optimistic and streaming state keyed by `(conversationId, branchId)`.
- [ ] Enable regeneration on every completed assistant and navigate to the returned branch only after the durable `done` event.
- [ ] Add a compact sibling selector at forked assistant responses; preserve the existing message actions and proposal status placement.
- [ ] Test branch switching during an active stream, cancelled regeneration, back/forward navigation, and latest-only state within each selected branch.
- [ ] Run ChatPanel/API client tests and web typecheck.

### Task 5: Branch expiry and end-to-end verification

**Files:** `apps/api/src/chat/conversations.ts`, `apps/api/src/chat/conversations.test.ts`, `apps/api/src/chat/conversation-deletion-sql.test.ts`, `apps/web/e2e/whereabouts.spec.ts`

- [ ] Add SQL tests showing activity on either branch renews the shared thread expiry.
- [ ] At thread expiry, clear every branch memory thread and transcript while preserving an attached note.
- [ ] Add an end-to-end case: create three turns, regenerate the middle assistant, verify the original downstream path remains selectable, continue the new branch, switch between URLs, and confirm both paths use the same note.
- [ ] Run API tests, web tests, typechecks, and the targeted Playwright scenario.

## Explicit non-goals

- No message copying, editable branch names, branch merging, or cross-conversation branches.
- No independent notes per branch.
- No garbage collection of shared message DAG nodes in the first implementation.
- No changes to source message IDs, existing note provenance IDs, or accepted note-edit history.

## Implementation and browser evidence (2026-09-18)

Migration 0010 applied locally after preserving an orphan historical suggestion during backfill. Messages use parent links; insert-time sequence allocation prevents sibling completion collisions. Regeneration passes its new branch ID and only the selected prefix to Mastra. Thread inactivity expiry covers all branches and keeps the attached note. Canceled regeneration does not replace the original selectable path.

Chrome QA on research thread `a84f4fc3-7f4a-4a64-a4c2-514a55663821` regenerated the first of eight assistant responses into branch `7a8be2ed-fc5c-4f67-9553-ecdbe6bd9ce3`. The new URL contained the branch ID and showed two messages; choosing Path 1 restored all 16 original messages. Choosing Path 2 and reloading retained its two-message transcript and the same note. A further user turn called real AI Search and rendered a cited result immediately, bringing the new path to four messages. Source retrieval and continuation therefore passed through the actual browser/API/model stack.

The compact selector currently sits above the transcript and lists response paths. Fork-local sibling controls remain a possible UX improvement. Browser back/forward, cancellation mid-generation, and simultaneous branch streams are covered partly by focused tests but have not all been exercised live. No deployment occurred.
