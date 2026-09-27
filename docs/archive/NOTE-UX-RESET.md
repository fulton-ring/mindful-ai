# Note interaction reassessment — 2026-09-18

Status: replacement interaction implemented with partial browser verification. Regeneration branches and several concurrency/cancellation cases remain queued.

The acceptance criterion remains a coherent writing experience. Automated checks support the implementation, but only the browser observations below count as browser verification.

## Observed in Chrome

Latest shared-flow verification: on the isolated finance QA thread, Add to note saved the exact selected sentence through proposal SSE and the suggestion decision endpoint. Existing note paragraphs remained intact. Undo restored the insertion as the standard inline ghost with Accept/Reject controls, and that pending ghost survived reload. After rejection, Propose note on the same older response generated a concise ghost and waited for acceptance; Chrome visual inspection confirmed the shared inline controls and gray text. The separate capture card has been removed. An earlier browser attempt exposed contradictory copied-anchor instructions; these were removed, and explicit capture text is now supplied by the server after model placement. These observations supersede the older capture-card observations below. Smoothness during inference and concurrent typing still need separate browser verification.

The latest pass used a synthetic finance prompt and a multi-section note.

Additional shared-flow pass: typed `Q` into the first paragraph while manual proposal generation ran. The edited paragraph and pending ghost both survived. Closed and reopened the panel, clicked the ghost and pressed Tab; it committed while preserving that edit. This verifies unrelated typing during this generation and visibility changes after completion, not every network race or panel closure during generation.

| Scenario | Observation | Result |
| --- | --- | --- |
| Add highlighted finance text to an existing note | The selected text appears immediately while placement runs, then lands under the relevant Bonds section. | Pass for this case |
| Quality of automatic proposal | The automatic ghost is one concise, relevant bullet rather than schema/heading echo or operational chatter. | Pass for this case |
| Accept ghost by click and by cursor + Tab | Both paths commit the shown text. Tab still works after reload. | Pass for these cases |
| Type over a ghost | Typing over the proposed range dismisses the suggestion without overwriting the user's text. | Pass for this case |
| Undo after typing-over dismissal | Undo restores the dismissed ghost for review. | Pass for this case |
| Settings navigation | Settings opens as a modal and the browser URL remains unchanged. | Pass |
| Sidebar overflow | Chrome measured a 615px region with 620px content. Keyboard scrolling moved it to scrollTop 4.5 while the footer stayed at y=680.2. | Pass for keyboard scrolling; wheel not separately exercised |
| Cancel explicit capture while placement runs | Add to note → Cancel removed pending feedback and left existing note content unchanged. | Pass for this case |
| Read-page tool activity and sources | Chrome showed one completed compact “Read page” control, one source disclosure link, and the inline Markdown citation. The activity and source each remained after reload. | Pass for `readWebPage` |
| Search-sources tool activity and sources | A real browser run is still pending. | Unverified |

Still required: simultaneous typing near and away from placement while generation runs; panel close/reopen during generation; cross-tab revision conflict; reload during generation; retry after deleting accepted text; real sidebar wheel scrolling with overflow; and a live `searchSources` tool/source run. These are not marked as verified by automated tests or earlier reports.

## Earlier causes and implemented corrections

The implementation now separates immediate capture feedback from asynchronous placement, keeps the foreground proposal stable during hydration, gives repeated attempts distinct durable identities, permits proposals from older completed responses after source revalidation, and distinguishes an arriving insertion from a deletion. Schema/heading echo from structured generation was also fixed. The local repeat-suggestion migration supports the new history behavior, and typing-over dismissal participates in undo.

These corrections do not establish every race as solved. Cross-tab revision conflicts, close/reopen during generation, and retry after deleting accepted text still require the browser cases below.

## Replacement interaction contract

Preserve the user's existing decisions; no new confirmation flow and no automatic append-only shortcut.

- **Shared mechanism:** Add to note and Propose note use the same proposal stream, inline ghost, cancellation, durable suggestion, revision checks, and decision history. There is no separate capture progress card.
- **Add to note:** supply the selected content as an explicit capture prompt. Preserve it verbatim and automatically accept the finalized suggestion through the shared decision path, after flushing concurrent typing. Undo reverses the acceptance.
- **Propose note:** generate one concise takeaway through that same stream. Resolve placement before showing the ghost, then animate arriving text. Reject remains available during generation. Accept/Tab becomes available when the edit is finalized and durable.
- **Writing alongside a suggestion:** unrelated typing continues. Map placement through local transactions; revalidate a unique anchor against the latest revision. Typing over a ghost intentionally dismisses it. A conflicting automatic insertion must not overwrite user text or silently relocate; retain the pending operation and offer retry.
- **Feedback:** the pending operation, ghost, save state, and error share one source of truth. Never show Saved as the status of unaccepted text. Never display Delete for a zero-character animation frame. A retry/error belongs beside its insertion operation, with dismiss and retry controls.
- **Automatic suggestions:** no tool-status chatter, generic restatements, or unnecessary notes. Open the drawer only after a worthwhile proposal has content and placement, unless the user explicitly opened it or requested Add to note. Respect dismissal of the panel.

## Data and implementation sequence

1. Give each attempt its own server-generated ID. Source message ID is attribution, not identity. Preview and final events retain that attempt ID. Persist decided attempts for history. An explicit retry creates a fresh attempt; automatic reruns respect prior decisions.
2. Establish one foreground operation per note in the UI. Query hydration reconciles that operation; it must not substitute an unrelated pending row. Other pending suggestions remain stored but are not silently promoted while a foreground operation is active or has just failed.
3. Share placement validation and optimistic revision commits between explicit capture and proposed edits. Separate known text from placement output; avoid asking a model to reproduce the full existing anchor and selected quotation. Validate model placement before applying. Keep the existing provider initially; benchmark Morph separately only if placement inference remains the bottleneck.
4. Fix exact-source persistence guards, retry identity, and undo semantics together. With a newer pending attempt, undoing an older rejection returns a clear resolve-newer-suggestion conflict instead of a generic failure. Test the migration with real SQLite history fixtures before applying it locally. No remote migration.
5. Replace the editor's fragmented proposal/reveal/status state with the operation lifecycle, then polish Markdown rendering, ghost color, controls, and insertion feedback. Animate arriving content without replaying the full typing animation after reload.
6. Run the browser matrix below on the resulting implementation. Record actual outcomes and timings, not merely screenshots or passing component tests.

## Browser acceptance matrix

Use a new QA thread with the user's 30-year-yield/HYSA question and a note containing multiple Markdown sections. Preserve unrelated text byte-for-byte.

- Empty/new note: Add to note has immediate feedback and no placement inference.
- Existing note: content lands in the relevant section; pending state is visible immediately; successful save is explicit.
- Automatic proposal: concise and relevant; drawer opens only once a useful ghost exists.
- Accept by click and by cursor + Tab; reject by click, Escape, and typing over the ghost.
- Reject during generation cancels it without later resurrection.
- Delete accepted text, request it again, accept it again: no no-op lie or identity collision.
- Propose from an older response: current note context, original source attribution.
- Type above, below, and at the anchor while generation runs; no overwritten typing or surprise relocation.
- Close/reopen, change thread, reload, and open another tab: no silent disappearance or replacement of the active suggestion.
- Undo/redo acceptance, rejection, and explicit capture, including after reload.
- Offline/server failure and revision conflict: pending text preserved, actionable local error, retry idempotent.

Migrations `0008_repeat_note_suggestions.sql` and `0009_message_activity.sql` have been applied to the local D1 database only. No remote migration or deployment is claimed.

Fresh-thread AI Search browser check: a native Search sources call completed and returned no results for the previously indexed Example Domain page. Retrieval of that page is not established. In the older research thread, the model claimed a search result without a new tool event; preventing stale tool-result claims remains a follow-up.

## Placement latency instrumentation

The capture-placement response now exposes `Server-Timing` entries for `note_lookup` and `model_placement`, including empty/duplicate/error paths. A representative synthetic finance note took about 1.3 seconds for the live model call in one sample; this is not a measured end-to-end click-to-save latency or a percentile. The production output cap remains 300 tokens because an anchor can be a long complete paragraph. Empty and duplicate notes bypass placement inference. Full browser click-to-save timing remains to measure.

## Exact capture failure correction

The user reported `Could not find a place for this text` for a two-paragraph note (`test test` plus the HYSA/net-interest-margin paragraph) and the selected sentence about 30-year yields and long-term expectations. The old placement output required an exact copied, complete-line anchor. Placement now selects a numbered existing Markdown block plus before/after; the server constructs the exact anchor and expands surrounding context when blocks repeat.

Chrome verified the exact note and selection in synthetic thread `654d3ca2-c582-47d6-a620-6e276603d6ef`. The sentence was inserted before the HYSA paragraph, following `test test`; both original paragraphs remained byte-for-byte unchanged. D1 revision 19 confirms the saved result. No confirmation step or error appeared.

Additional observations queued: the automatic proposer once echoed existing note text in its ghost, and it proposed despite a test prompt saying not to propose a note. Automatic suggestions still use their own edit-generation path; they should share the reliable placement representation without sacrificing streamed ghost edits or replacement support. A branch-integration cache-key regression hid a newly completed response until reload; its persisted transcript was intact and the frontend correction is underway.
