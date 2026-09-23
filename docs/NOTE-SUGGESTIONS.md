# Durable note suggestions and decision history

## Original problem

A ghost is currently a browser-owned edit proposal, while the note is server-owned. Acceptance loses suggestion identity, rejection disappears, and the existing content-only undo implementation cannot undo consecutive edits. Browser storage can recover a ghost after a reload but cannot provide durable decisions or consistent history across tabs.

## Intended behavior

The persisted note contains only committed Markdown. Separate suggestion records supply pending text projected into the editor's document and styled differently. Multiple candidates retain separate identities. Clicking a candidate's text or its line, then pressing Tab, accepts only that candidate; Escape rejects only that candidate. Ambiguous lines require explicit per-candidate controls. Typing across pending text dismisses the touched candidates and retains the user's edit without committing other pending text. Closing the panel only changes visibility.

Undoing acceptance restores the preceding note and the pending ghost. Undoing dismissal restores the ghost without changing the text. Redo repeats the corresponding action. New user actions after Undo abandon the redo branch. History and finalized suggestions persist independently of expiring chat transcripts.

The multi-candidate integration uses migration `0011_multi_suggestion_history.sql` to group suggestion status changes with a user edit, so one Undo restores all candidates dismissed by that edit. This migration is local-only; the editor and API integration are being verified before completion is claimed.

## Placement and fast apply

Resolve placement before displaying a ghost. Accept must commit the reviewed edit, not call a model that silently chooses a new location. Persist the proposal's base note revision/content and exact old/new text; old text includes enough surrounding context to be a unique anchor. For an empty note, the patch is an insertion. Screen positions are derived by the editor and are never stored.

If content changes, validate the stored patch against the new note. A uniquely resolvable patch can be prepared again; an ambiguous patch must be refreshed and shown before acceptance. Do not guess an insertion point or silently overwrite concurrent changes. Existing exact-patch generation already prepares placement; another model call at acceptance is unnecessary.

## Storage and API

- The durable product object is a thread: one title and at most one exclusively owned note. A new thread may start without a note. Its transcript is temporary child state; expiring a transcript does not delete its note, suggestions, or note history.
- Explicit thread deletion removes the thread, its note, suggestions, note history, and transcript atomically. This is distinct from seven days of inactivity, which removes only transcript state and permits a new line of questioning with the retained note in context.
- `notes` remains committed content plus optimistic revision.
- `note_suggestions` stores finalized patches, source identifiers, base revision, and lifecycle status. Source transcript identifiers must not cascade-delete permanent note state.
- `note_edits` records one ordered history of user edits, acceptance, and dismissal, with before/after content and suggestion status changes in `suggestion_changes_json`.
- Revisions increase on durable state changes. Undo/Redo validate current state and move through the history branch rather than requiring current revision to equal an old edit's original result revision.
- A first finalized suggestion may create and link an empty note resource. This does not commit proposed text or cause an empty panel to open before there is a suggestion worth displaying.
- Generation writes only finalized suggestions before sending its terminal event. Streaming previews remain provisional. Retries reuse the stored generation result.
- `GET /api/notes/:id/state` returns note, pending suggestions, and Undo/Redo availability.
- `POST /api/notes/:id/suggestions/:suggestionId/decision` accepts `decision`, `baseRevision`, and `operationId`.
- Undo/Redo accept the same expected revision and idempotency key.
- Note text and decision changes commit atomically. Conflicts return a recoverable error and never partially commit a history entry.

## UI integration

TanStack Query owns fetched note state. Server mutations update the note and ghost together. Focus/refetch reconciles changes from another tab; local dirty text is retained on conflicts. Session storage is no longer authoritative for proposals. The toolbar exposes Undo and Redo for saved note actions; local typing and durable history must not silently undo different things.

## Verification

Use real SQLite tests for accept/reject, undo-dismiss, multi-step Undo/Redo, redo branch discard, duplicate operations, stale revisions, and first-note creation. Use Chrome to verify cursor + Tab, typing-to-dismiss, reload, panel close/reopen, and cross-tab refresh. Keep telemetry to IDs, statuses, latency, errors, and counts; never record note/proposal/message text in PostHog.

## Queue

1. Implement and verify the durable suggestion/history model above.
2. Fix first-send layout: enter full-height conversation mode immediately and keep the composer at the bottom during response streaming.
3. Stream secondary classifier and note-proposal progress so highlights and proposed text animate incrementally as they arrive. Preserve separate asynchronous calls after the main answer finishes; finalized server suggestion storage remains atomic.
4. Replace the highlight hover label with a shadcn tooltip and a short opening delay; preserve click-to-open actions and keyboard access.
5. Research the installed Mastra version's native memory, compaction, message processors, and tool-output/context budgets. Prefer native features; preserve seven-day transcript expiry and metrics-only PostHog telemetry. Use current official documentation and installed API signatures before implementation.

### Additional queued UX requests

6. Confirm deletion before removing a thread, including an actively streaming thread. Cancel leaves it intact; confirmation uses the existing cancellation/deletion path.
7. Rename user-facing conversations to threads consistently. Internal identifiers and API routes need not change just for terminology.
8. Tailor highlight actions to their classification rather than repeating the same actions for every kind.
9. Keep highlight tooltip and click-menu styling consistent using shadcn primitives. Fold styling into the tooltip implementation already underway; do not interrupt earlier work.

### Implementation status

The durable suggestion/history model, fixed-height first-send layout, lazy-route streaming fix, progressive classifier SSE, persistent final ghost reconciliation, fast Radix tooltip, and native per-step Mastra context guard are implemented. D1 remains the only transcript store; no duplicate memory/observation store was added. Thread terminology, deletion confirmation, and classification-specific menus are implemented and verified in Chrome. The final keyboard check also verifies Escape returns focus to the original highlighted passage.

### Next queued message controls

Add a per-assistant-response toolbar: Highlight, Propose note, Regenerate, Copy. Keep automatic secondary calls after primary `done`; manual actions expose progress/retry without duplicate in-flight jobs. Copy uses response Markdown. Regeneration must have explicit transcript semantics and must not silently duplicate the original user message or erase accepted note content. Finish the corrected aggregate deletion path before implementing this toolbar.

Toolbar implementation semantics: automatic secondary calls launch independently on the frontend's primary `done` event; they need not wait for the last visual text-animation frame. Manual Highlight reclassifies that response. Propose note reopens a pending durable suggestion or reports that no suggestion is available, and is limited to the latest response so it uses current note context. Regenerate initially applies only to the latest completed assistant response, uses the stored preceding user prompt, preserves the old response on failure/cancellation, and replaces it only on successful completion with a new source message ID. It does not duplicate a user message, extend transcript expiry, or overwrite accepted note content. Copy copies response Markdown.

Toolbar status: implemented and checked in Chrome. Copy feedback, successful in-place regeneration, streamed manual note proposal, and manual classification completion were verified. The corrected thread-deletion behavior is also implemented and browser/database verified; migration 0007 was applied locally only.

## 2026-09-18 update: shared placement and concurrent typing

- Automatic proposals can capture a selective, durable explanatory takeaway as well as user decisions/constraints. Manual proposals and explicit Add to note use the same proposer. Invalid final length/anchor output gets one bounded repair attempt; unsafe results remain uncommitted.
- `POST /api/conversations/:id/capture-placement` returns a provisional exact anchored insertion for selected text. It cannot delete/rewrite existing text and must preserve the selected text verbatim. The browser resolves it against the latest draft, saves without another confirmation, and reveals the insertion. If the anchor changed, it flushes and asks for placement once more; persistent conflicts leave the note untouched. An empty note has only one insertion point and uses the existing direct capture path.
- Final suggestions rebase onto the latest note only when their exact anchor is still unique. Unrelated note edits no longer silently discard a finished suggestion. Edited or ambiguous anchors report a recoverable error. Accept uses the current optimistic revision and the same exact-anchor validation; it does not silently move an edit via a new model call.
- Streaming ghosts survive unrelated typing. Typing over the actual changed range dismisses intentionally; editing elsewhere in the anchor no longer automatically cancels generation. Hydration preserves dirty drafts. The short acceptance commit disables editing; model generation does not.
- Generation failures and no-op notices are attached to the source response toolbar with dismiss/retry controls.

Older-message Propose note is implemented: every completed assistant response can request a suggestion using the current note. The original source message must still exist before persistence; original user/assistant context and source attribution are retained. Older-message regeneration as a branch with branch-scoped context remains queued.

Live Chrome verification: a real Gemma suggestion survives reload and accepts with Tab; a second proposal inserts a concise decision ahead of the existing paragraph without changing that paragraph. Prompt rules now distinguish verbatim capture from generated explicit-request suggestions and explain anchors for additions to nonempty notes.

Native Cloudflare structured output is now used for note generation and repair. Prompt-only schema injection had produced an invalid schema-shaped envelope in a real run. After the switch, the automatic post-response generation path produced and persisted an anchored ghost bullet without a manual retry.
