# Note application review — 2026-09-20

## Architecture

The canonical note contains committed Markdown and provenance. Pending proposals remain separate records. The editor projects those proposals into a temporary document; its position map translates typing back into canonical coordinates. Additions use a shared ordered queue, including accepted entries as anchors. Replacements require a unique exact match of `oldText`.

Accept first flushes local typing. The API loads the latest note, validates the proposal, and applies a conditional D1 batch that records the operation, note history, revision, and suggestion decision together. Operation IDs support replay. Undo and redo restore both document and suggestion state.

Proposal generation now has one request object containing the source ID, target note ID, phase (`streaming` or `loading`), and immutable preview IDs. Single and batch results use the same completion function. Loading saved state belongs to that request; a response from a retired request cannot clear or overwrite a newer request. Completion, decline, failure, and cancellation release the request. Decision saving has its own accurately named `decisionPending` flag.

The foreground proposal remains separate because the editor can continue revealing its text after generation has completed. Persisted suggestions and the canonical note remain independently reviewable.

## Confirmed bugs and fixes

1. **Completed single proposals stayed blocked.** The single-result handler returned to hydrate saved state before clearing preview IDs. Live reproduction: “Note suggestion ready” alongside “Suggesting…” and a disabled Accept button. Terminal cleanup now happens before early returns. An App integration test reproduces preview → completion → hydration → acceptance.
2. **CodeMirror buttons retained stale streaming state.** Changing only the preview ID set did not rerun the decoration effect. The parent now replaces preview IDs immutably, and the effect depends directly on that set and the other control inputs. A component regression verifies the disabled button becomes enabled and invokes acceptance.
3. **Submitted Markdown bypassed replacement validation.** A stale replacement whose anchor was gone could be accepted as an insertion when the client submitted its new text. The submitted-insertion shortcut is now limited to proposals with empty `oldText`. An API regression verifies HTTP 409 and an unchanged note for the invalid replacement.

Each regression was observed failing before its fix.

## Browser evaluation

Started with `pnpm dev`, using the authenticated local app at http://localhost:5173 and synthetic plant-care content in thread `26536a1d-129d-4e2a-89e6-bfa69cc048e3`.

Verified through the UI:

- Reproduced the original blocked acceptance after annotation → Add to note.
- Accepted the persisted proposal and observed Saved.
- Generated fresh single proposals; Accept became enabled without reload.
- Kept two proposals pending and accepted the second displayed one first.
- Typed beside a pending proposal, then accepted it; user text remained intact.
- Undid and redid acceptance, preserving user text and restoring/removing the pending controls.
- Rejected one restored proposal without disturbing the committed note.

One generation attempt incorrectly declined a distinct capture as redundant with the conversation. Retrying later produced the requested proposal. This is a remaining model-quality observation, separate from deterministic acceptance; the current prompt already directs comparison against the note and pending proposals. No claim of exhaustive model-output coverage is made.

## Simplification

- Unified single and batch completion, including saved-state loading and error cleanup.
- Removed unused foreground/hydration bookkeeping, the always-false capture guard, source-rejection sets, and redundant snapshot fields.
- Removed `latestVisibleSuggestion`, `proposalDuringStateHydration`, and `prepareSuggestionDecision`: only tests called them. Replaced their misleading coverage with tests of the actual App callbacks.
- Removed serialized preview IDs, an unused editor scroll prop and view field, and an unused queue coordinate.
- Shortened historical bug narratives to comments explaining current invariants.

Production code is 252 lines shorter. No dependencies or database migrations were added. Exact replacement matching, addition ordering, provenance, and atomic history updates remain in the existing domain/API implementation.

## Verification after cleanup

- `pnpm typecheck`: passed.
- `pnpm test`: 586 passed, 10 provider-dependent tests skipped.
- `pnpm build`: passed (Worker dry run).
- Biome check of all six changed source/test files: passed.
- App lifecycle tests cover single and batch results, first-note binding, decline/failure cleanup, cancellation, old completions, delayed loading, and failed loading.
- Browser check in fresh local thread `571c9ab5-3f31-4235-a897-c8326b22456e`: generated a first note from a chat annotation, observed enabled Accept after completion, accepted it, and observed Saved with the proposal controls removed.

Local services remain running. The checkout reported the project files as untracked before this work.
