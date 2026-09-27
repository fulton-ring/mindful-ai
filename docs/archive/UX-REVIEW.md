# Local UX review — 2026-09-18

Review target: a focused chat workspace with user-owned Markdown notes. Keep controls quiet, obvious, and close to what they affect. All review work stayed local; nothing was deployed.

## Round 1 — flow and state

- Replaced the stale demo server at localhost:8788 with the real Vite frontend and Cloudflare/Mastra API.
- Fixed first-conversation navigation clearing an arriving note suggestion.
- Guarded streams against conversation switches and flushed note saves before navigation.
- Removed editor gutters, line numbers, coding defaults, and active-line decoration.
- Added inline capture proposals for the first note, including accept/dismiss controls.

## Round 2 — layout and controls

- Bounded chat/composer width and grouped the empty prompt with the composer.
- Left-aligned sidebar controls, moved account controls to the bottom, and used Lucide icons.
- Simplified the input placeholder and removed colored input focus outlines.
- Reduced note padding and added a resizable chat/note divider with remembered width.
- Hid Open note while the note is visible; placed Close note at the far right. Removed Delete note.
- Replaced persona native selects with Radix controls, fixed modal positioning/focus restoration, and removed Delete from unsaved personas.
- Removed duplicate mobile note controls and made the closed mobile sidebar inert.

## Round 3 — Chrome with real services

Used Chrome MCP, not mocked network responses, for these checks:

- Clerk signed-in workspace requests. Found the actual failure: authorized parties omitted localhost:8788 and environment-file precedence kept overriding the checked-in change. The local dev command now explicitly supplies the local origins.
- Real Gemma request through Mastra and Cloudflare Workers AI.
- Model proposal opens the note, acceptance saves the text, and reload/reopening retains it and the chat history.
- Persona selection, settings navigation, modal Escape dismissal, desktop and mobile layouts, light/dark appearance.
- Text-selection toolbar appears beside the selected phrase, with Challenge, Dive deeper, and Add to note; clicking the input removes it.
- Closing the note preserves the unsent chat draft.
- Keyboard resizing changes the note/chat split.

Authentication now requires Clerk; guest and deterministic demo paths were removed. A 401 gets one retry with a freshly requested Clerk token, never an unauthenticated fallback.

## Remaining follow-up

- Pending suggestions are transient UI state and do not survive a full reload. Accepted notes do persist.
- Existing older demo-oriented Playwright flows need rewriting for Clerk before they can serve as a full automated regression suite. They were not run against the user's workspace.
- The production frontend build still reports a large JavaScript bundle; split editor/settings dependencies in a later performance sweep.
- This review covers local Chrome, not a cross-browser or real-device matrix. Stripe remains disabled and no deployment was performed.

## Follow-up corrections from review

- Unified titles under `conversations.title`; migration 0004 removes `notes.title`. Renaming through the note header updates the conversation sidebar immediately.
- A real replacement proposal arrived while the panel was dismissed; it stayed closed. Reopening displayed the pending inline edit at the existing text, with nearby accept/dismiss controls.
- Final verification before Markdown live-preview work: workspace typecheck and unit tests passed (30 API, 6 web, 7 domain; one optional live test skipped); frontend production build passed with the known bundle-size warning.

## Issues found during real use

- **Fixed: inherited-note leak.** New conversation creation passed the last draft's note ID. It now always creates an unlinked conversation, and note selection resolves only from the active conversation. The exact synthetic-only note accidentally attached to the user's conversation was unlinked without deleting messages.
- **Fixed: invisible Gemma completion.** The failed turn consumed all 900 output tokens on hidden reasoning and returned no text after 14.3 seconds. Thinking is now disabled for this flow. The subsequent live Chrome turn returned visible text in 2 seconds (75 output tokens). Empty completions now surface errors, and frontend stream truncation/timeouts no longer disappear silently.
- Replaced the initial status with “Thinking…”.

## Suggested-edit interaction (September 18)

Research: [Cursor Agent](https://prod.cursor.com/help/ai-features/agent#how-do-i-review-agent-changes) uses diff review and rejection of unwanted edits. [VS Code review controls](https://code.visualstudio.com/docs/agents/run/review-code-edits#review-agent-changes) documents per-edit Keep/Undo controls, including inline actions in its extension-host workflow. These tools may save edits before review; Walden's proposed note text must remain outside the saved note until accepted.

Chosen interaction: show the proposed addition at its insertion point, or strike through replaced text beside its replacement. Place compact “Suggested · Not saved”, Accept (Tab), and Reject (Esc) controls with that change. Do not rely on color or keyboard discovery alone. Tab applies only when the editor caret is at the suggestion; clicking a button works independently of caret position. Rejection leaves saved text untouched.

Explicit “Add to note” already expresses approval: save immediately, open the note, and scroll to the addition. Model-initiated suggestions retain the review step. A separate review dialog or side-by-side diff would add unnecessary navigation for a single Markdown note.

Text streaming should absorb bursty network chunks with a short, bounded reveal delay. Newly classified spans receive a brief left-to-right highlight sweep, while annotations loaded from history remain static. Respect reduced motion for both effects and preserve normal text selection.

Interrupted turn recovery now checks the persisted turn age against the generation deadline plus grace (90 seconds). A missing in-memory controller alone is insufficient because Cloudflare can run concurrent isolates. Both same-request retries and new requests after reload can release stale conversation locks while preserving user messages.

## Active end-to-end checklist

- [x] Clicking an existing semantic highlight directly opens its contextual menu beside the span, labeled with its classification (Fact, Claim, Assumption, Question, etc.). Actions: Dig deeper, Challenge, Add to note. Chrome verified click, keyboard activation, Escape/focus return, arbitrary manual selection, and direct note capture. Scroll/resize dismissal and split-Markdown quotes covered by regression tests.

- [x] Real model responds to the exact 30-year-yield question; fresh chat starts without an inherited note and keeps note panel closed.
- [x] Responses render Markdown headings, ordered/unordered lists, and bold text.
- [x] Semantic annotations are visible on the latest response and persist across reload. Fixed Streamdown processor cache reuse by putting changing annotation data in plugin options.
- [x] Explicit Add to note saves without confirmation, opens the panel, and reveals appended text.
- [x] Reasoning events use a separate stream field and persisted field; UI opens during reasoning and collapses afterward (component tests). Extended thinking remains disabled by default to avoid the earlier no-answer failure.
- [x] App usage cap removed; turn/token accounting retained.
- [x] Real model replacement appears inline with Accept/Reject; Tab acceptance confirmed in Chrome. Deletion-only proposal and Reject button verified in Chrome: saved text remained unchanged. Disabled keyboard acceptance and first-note read-only acceptance covered by component tests. A separate browser check of editor Escape remains outstanding.
- [x] Accepted Markdown note renders bullets/bold, autosaves, survives reload, and resizes via divider keyboard controls.
- [x] Persona tone select, temporary persona create/delete, and light/dark appearance checked in Chrome after renderer changes.
- [x] Run the yield prompt again against the context changes and grade factual/causal clarity. Streaming/UI passed; answer quality remains below the rubric due to a misleading “ceiling” analogy (see CHAT-EVALUATION.md).
- [ ] Verify PostHog event delivery after user supplies a project key. Metrics-only US integration; no transcript export.

## September 18 — direct highlight actions and deletion review

- Consolidated selection and annotation menus. Classification labels occupy their own readable row, above Dig deeper / Challenge / Add to note. Links keep their normal navigation behavior; source text inside links is not made into a competing annotation button.
- Corrected highlight animation to reveal only the colored background, rather than clipping the response text itself.
- Fixed missing review controls for deletion-only edits and blocked Tab acceptance while note saving is disabled. Initial unsaved note proposals remain acceptable even though typing in that editor is read-only.
- Real Chrome + Cloudflare tests: direct highlight capture opened and saved a new note without confirmation; manual selection still worked; a real deletion proposal displayed inline and rejection preserved the saved note.
- Verification: workspace typecheck, 89 unit tests, targeted Biome checks, and frontend production build passed. One optional live-inference unit test skipped; real inference exercised through Chrome. Existing bundle-size warning remains.

### Next reliability sweep

- A natural-language deletion request still produced a prose-only claim that an edit was ready, with no intervention row. Explicitly retrying with the note-edit tool produced the correct deletion proposal. Treat this as an unresolved tool-use reliability failure, not an editor failure.
- Accepted/rejected note interventions are not currently resolved in the server's interventions table; an earlier accepted proposal remained pending during a read-only local QA query. Synchronize proposal lifecycle with persistence and stop presenting stale proposal state to subsequent turns. Its effect on model behavior is a hypothesis, not established causation.

## September 18 — classification simplification

Active response highlights are now Fact, Claim, Assumption, Question, and Decision, with distinct colors. The classifier has explicit category definitions and uses Claim when uncertain between Fact and Claim. A Fact label is not independent verification. Numeric values and references are classified only within meaningful statements, rather than as standalone Number/Source labels. Retired Reasoning/Number/Source annotations remain readable in stored transcripts but are not highlighted or relabeled as facts.

Provider reasoning remains separate in the AI Elements-derived Reasoning component (open while streaming, collapsed afterward). Extended thinking remains disabled in the current Gemma configuration because it previously exhausted the generation budget without an answer.

Chrome verified the larger classification label and the smaller top-right close button, with actions in a separate row. Regression tests cover preserving historical text when retired highlights are hidden. API/web tests, workspace typecheck, targeted Biome checks, and frontend build passed; the existing bundle warning remains.

### Explanation category

Added Explanation as the sixth active category: visible answer passages connecting mechanisms or premises to outcomes (how/why), rather than standalone descriptive facts (what). It uses muted coral, distinct from the other categories. This classification is not a truth guarantee and does not represent private model reasoning. Number and Source remain retired; old Reasoning annotations are not automatically relabeled.

The action popup now uses a local shadcn-style Radix Popover component with a virtual text anchor. Radix handles portal placement, collisions, outside interaction, and Escape instead of bespoke position calculations and document-level dismissal listeners. Chrome verified click, keyboard focus on Dig deeper, Escape/focus return, arbitrary selected text, and outside-click dismissal. A real Cloudflare response to “Why does ice float on liquid water? Keep it to two sentences.” showed distinct Explanation and Fact highlights; the Explanation popup had the larger label and small top-right close control.

Popover verification: API tests (55), web typecheck, targeted Biome checks, and frontend build passed. All nine highlight interaction tests reported passing assertions, but the full jsdom run was abnormally slow and did not finish cleanly (one worker RPC timeout, subsequent run interrupted after all assertions passed). Isolated keyboard regression exits successfully. Investigate the test-runtime regression in the next tooling sweep; do not count this as a clean full-suite pass or assume concurrency is the cause. Real Chrome checks above passed.

## September 18 — independent secondary calls and interruption handling

The primary answer now completes and persists before the browser starts two independent authenticated requests: message annotations and a streamed note proposal. Each has its own abort controller and deadline (10s classification, 25s note suggestion; primary 75s). Notes use Mastra structured `objectStream` output, stable proposal identity, exact-note edit validation, and a revision/context check before final completion. Suggestions remain provisional until accepted; unaccepted suggestions are not restored on reload.

The UI paces answer text, animates newly arriving highlight backgrounds for 600ms, and reveals streamed ghost text inside the note editor. Accept/Tab stays disabled during streaming or unfinished reveal; Reject remains available. Reduced-motion preferences skip visual animation. A meaningful preview opens the drawer unless it was dismissed. Source IDs and draft snapshots reject stale background results.

Leaving the conversation, stopping, or pagehide cancels active requests. Simply hiding the browser tab does not cancel. Server streams register cleanup with waitUntil, forward disconnects, guard completion against cancellation, and save partial answers as incomplete. This is bounded cancellation cleanup, not a durable background-job/reconnection system; browser/process crashes can still require orphaned-turn recovery.

Real Chrome checks: a fresh secondary model proposal opened an inline ghost, and the user's exact yield prompt completed with Markdown and independent Claim/Fact/Explanation highlights. A dismissed drawer stayed closed. Navigating to Settings during a subsequent response and returning showed an incomplete answer; a local D1 check confirmed cancelled status with 46 saved characters. Initial first-note Accept followed immediately by Send exposed a create/save/link race (the note saved but linking lost to the next active turn); a capture sequencing fix is in progress and must be retested before treating acceptance as verified.

The slow Popover jsdom harness was isolated to positioning machinery. Unit tests now mock the local Popover wrapper while preserving controlled state, focus callbacks, Escape, refs, and rendered actions. Actual Radix positioning/outside interaction remains covered by the earlier real Chrome checks. Full web suite now exits cleanly: 38 tests passed before the capture-race fix. API: 67 passed, one optional live test skipped. Frontend build passed with the existing large-bundle warning.

### Acceptance-race follow-up

Fixed capture sequencing: turn submission awaits an in-progress note create/save/link operation, and duplicate Accept clicks are guarded synchronously. The target conversation is resolved explicitly instead of falling back to an accidental new conversation. The full web suite passed 40 tests after this change.

Real Chrome regression used a fictional plant-care note: Accept immediately followed by Send completed, displayed the saved note, and produced a normal next response. A local D1 read confirmed that the original conversation points to the note at revision 1 with exactly `Water the imaginary fern every Monday.` No additional confirmation was needed. A repeated financial-note test submission was rejected by automatic review; the final persistence regression used the harmless fictional fixture.

A separate blank ghost-editor observation was traced to Vite Fast Refresh retaining a CodeMirror editor with old module-scoped StateEffect/StateField identities. A full page reload restored the ghost; ordinary null-to-streaming-to-final lifecycle tests pass. A development-refresh remount fix follows, without rebuilding the editor on normal renders.

The accepted fictional note also survived a full Chrome reload. The HMR fix now rebuilds CodeMirror only when module-scoped effect/compartment identities change; 8 focused editor tests, typecheck, and Biome pass. No deployment was performed.

Final navigation guard: pending submission checks its preparation generation after both note flushing and conversation creation. A separate hard cancellation epoch prevents pagehide/unmount from being mistaken for lazy new-conversation adoption. Old request cleanup cannot reset a newer request. Targeted App/API transport tests (14), web typecheck, Biome, and the final frontend production build pass; the bundle-size warning remains. Full browser-tab closure/crash recovery is not claimed as E2E verified; route cancellation and saved-note reload were verified above.

## September 18 — atomic captures, classifier errors, and Stop continuity

Replaced first-note create/save/link requests with one authenticated `/api/conversations/:id/capture` transaction. The client retains the operation ID for retries of the same capture. Real SQLite tests execute the emitted SQL and verify note/history/link creation, idempotent replay, a turn-start race producing no partial rows, and rollback after a forced SQL error. Real Chrome accepted a fictional fern-note suggestion through this path; local D1 confirmed one linked revision-1 note and one edit-history row.

Annotation output is now bounded to six quotes of at most 320 characters, with a 1,000-token structured output budget. The previous unbounded quote length plus 500-token cap could truncate valid multi-sentence output. A valid empty classification still returns no highlights; actual generation errors now return a generic retryable failure instead of silently persisting an empty list. Failure logs contain only a fixed reason, never text. The UI offers message-specific Retry highlights, independently of note proposals and without blocking the composer. Tests verify the original input is reused and the note model is not called again.

Stop now marks received text incomplete, preserves the interrupted user/assistant exchange in local conversation state, and keeps it visible when another turn starts. Old callbacks cannot replace the new request. A further server-side sequence race was identified during this sweep: a new user message could take the delayed interrupted assistant's sequence. The allocator is being corrected and verified against SQLite.

Screen readers now announce suggestion preparation/readiness once per phase rather than repeatedly reading the entire growing ghost note. Visual streaming remains unchanged.

Model-quality finding: a synthetic acknowledgment ('I will suggest the note…') was labeled Decision despite the prompt explicitly excluding note-administration boilerplate. This is a semantic classifier error, not a streaming failure; do not interpret a successful structured result as correct classification.

### Final Stop/persistence regression

Fixed the server allocator to reserve an assistant sequence slot after every persisted user message, including cancelled turns whose cleanup has not yet written the partial. A SQLite regression verifies delayed insertion remains ordered as user/assistant/new user. The real Chrome test then stopped a fictional story mid-response, immediately sent a new message, and reloaded: interrupted history remained visible and the next response completed. Local D1 showed sequences 1–6 in order, including the cancelled assistant at sequence 4 (`incomplete=1`, 887 characters) and the next completed assistant at sequence 6. The saved note remained unchanged.

Validation this sweep: API full suite passed 77 tests before the allocator change; the allocator's targeted chat tests passed 7 tests. Web full suite passed 44 tests, updated editor tests passed 8, typechecks passed, and the final frontend build passed. The existing bundle-size warning and semantic classification-quality findings remain. No deployment.

## September 18 — missing highlights, deletion, and leaked tool syntax

Reproduced the reported missing highlights on an existing response: the classifier returned 503 after 8.17 seconds because its inner deadline was eight seconds. Increased the model deadline to 20 seconds and the outer request deadline to 25 seconds. The same response then returned five visible highlights in Chrome (15.49-second request). A fresh Moon-phases conversation subsequently produced two automatic Explanation highlights without using the manual recovery action.

Fixed independent UI races: annotation jobs survive later turns in the same conversation, pending annotations replay across delayed parent updates, and final smooth-stream drain rebases against current annotations. Targeted cross-turn regressions and the full web suite passed.

Conversation deletion now aborts local active model controllers after checking ownership, and accepts expired/stuck conversations. Chrome deletion of the synthetic Moon conversation during a subsequent response returned to the empty composer; a scoped local D1 check confirmed zero conversation and message rows. Saved notes retain the existing preservation behavior. The in-process abort registry is local to one Worker isolate; database deletion guards still prevent late transcript resurrection.

Gemma emitted `proposeAsk{...}` sentinel syntax as text under automatic tool choice. A narrow incremental decoder now recovers schema-valid ask/learning-check calls into existing interventions, preserving surrounding prose and enforcing learning consent. Exact reported input and one-character chunk regressions pass. This is tested recovery for that known protocol, not a claim that every malformed model output is repaired. API suite: 89 passed, one optional live test skipped; typecheck and Biome passed.

Automatic note proposals are now limited to approximately 50 changed words / 400 characters, except explicit requested captures. Saved AI-authored note text no longer has a dotted underline. The user has requested Gmail-style inline ghost text with local Tab acceptance and typing-to-dismiss; that interaction is being implemented and must be browser-verified before treating this note UX pass as complete.

### Inline ghost interaction verification

Replaced the diff-style preview with muted inline ghost text and end-of-suggestion Accept/Reject controls. Clicking a replacement selects its underlying document range; Tab accepts only at that range. Typing there dismisses before applying the user's text. First-note suggestions now have a writable local buffer with atomic creation and in-flight typing rebase; lazy conversation adoption bypasses only its own flush barrier to avoid self-await.

Chrome verified Monday → Tuesday by clicking the ghost and pressing Tab. The suggestion disappeared, normal text appeared, and local D1 confirmed revision 2 with `Water the imaginary fern every Tuesday.` Switching conversations and closing/reopening the note retained it. A separate first-note ghost was clicked and typed over with `W`; the ghost disappeared, only the typed text saved at revision 1, and reload showed that text. Focused App/editor tests: 17 passed. Frontend build passed with the existing large-bundle warning.

The user additionally requested pending-suggestion durability across reload and panel/tab switching; completed-proposal session restoration is in progress. The next queued request is the first-message layout transition: enter full-height conversation view immediately rather than allowing streamed response growth to move the composer.

## Durable suggestion and history verification

Replaced session-owned proposals with `note_suggestions` and extended `note_edits` to record accept/reject decisions and typing dismissal. Migration 0006 was applied locally. Final model results persist before terminal SSE; previews remain provisional. Note-state API restores ghosts independently of transcript lifetime. Toolbar and editor keyboard Undo/Redo share revision-guarded server history; typing-over saves the replacement and dismissal atomically.

Real Chrome fixture `3ab3abf0-76a3-4447-84a9-e5ba8b78ae16` verified: Reject → Undo restored the ghost; Redo dismissed it; Undo restored it again; close/reopen and reload retained it; clicking the ghost plus Tab committed text, and reload retained committed Markdown. Undoing acceptance restored the pending ghost, which was also visible in a separately opened browser tab. Typing `W` over that ghost saved the replacement; Undo restored the original empty note plus ghost. A scoped D1 check during the sequence confirmed revision 6, empty committed Markdown, pending suggestion, and two decision-history entries.

Validation: 98 API tests passed (one optional live test skipped); 59 web tests passed. Root reran 17 focused followup/SQL tests and 20 App/editor tests successfully. A duplicate-key error printed by the SQL rollback test is intentional. Typechecks and scoped Biome checks passed. No deployment.

The first-message full-height layout fix is now active; progressive secondary streams, fast shadcn highlight tooltips, and research/configuration of native Mastra context management remain queued in that order.

## First-message layout

Changed first-send layout to use optimistic activity during preflight rather than waiting for persisted messages. A real Chrome check exposed a second issue: percentage heights did not provide a definite size through the resizable panel chain. The desktop conversation group/chat panel now use viewport height, the composer does not shrink, and the message region owns scrolling. Existing mobile header offset remains applied. CSS also exits empty centering when rendered messages/activity exist.

Chrome measured the empty composer at y=357.6 in an 847px viewport; immediately after Send it moved to y=705.0, bottom=831, with panel height=847. A subsequent check retained the same bottom coordinate while the request was active. Typecheck, scoped Biome, and all 60 web tests passed. The next active queued item is progressive secondary-model streams.

Note-pane isolation follow-up: its resizable panel now has definite viewport height, fixed toolbar, and an independently scrolling editor region. Chrome measured chat panel=847px, chat scroll=705px with 974px content, composer bottom=831px, note panel=847px, and editor region=779px in an 847px viewport. Long chat content did not change the note's height. The additional moon-garden request used to measure first-send placement was explicitly deleted concurrently (DELETE 204 confirmed in server logs), explaining its later 404; it was not spontaneous record loss.

## First-send streaming and progressive followups

Fixed a lazy-route adoption race: `onEnsureConversation` navigated to the created conversation before returning its ID, so ChatPanel canceled its own pending first turn. An explicit adoption phase now preserves that matching turn while genuine navigation still cancels it. A regression test reproduces route adoption before ensure resolves and checks visible first-token delivery.

Chrome fixture `0b385d6d-2f52-4ae7-b59d-a4d3a54e3b83` verified a fresh-page Send with a partially visible Moon-phases response, followed by the complete response without reload or opening the note. Composer remained y=705.03125, bottom=831 through both observations. Six automatic highlights appeared after completion. A subsequent explicit note request produced the separate inline unsaved ghost and Accept/Reject controls; the composer retained its position and the note occupied its independent pane.

Classifier SSE now emits validated complete annotation items as they become available, then persists the complete list before done. Unfinished quote prefixes are withheld. Client merges by stable ID and preserves cancellation/retry behavior. Final note reconciliation preserves the editor instance to avoid replaying the entire ghost animation. API: 103 tests passed, one optional live test skipped. Web: 63 tests passed after the route regression. Browser observations verify live main response, final highlights, and ghost display; precise per-item arrival timing is covered by focused streaming tests rather than claimed from the browser snapshots.

## Thread deletion and interface cleanup

Removed the generic Add highlights prompt after empty/unclassified responses; only actual classification failures expose Retry and active requests show progress. Live and saved assistant rows use the same persona label. Added native Mastra per-step token limiting with protection for current request/note context; 105 API tests pass, one optional live test skipped.

Renamed user-facing conversations to threads while keeping API identifiers/routes stable. Added a Radix modal deletion confirmation with title, saved-note retention description, default Cancel focus, pending guard, and inline failure. Chrome verified Cancel preserves the synthetic fern-story thread, then confirmed deletion removes it while keeping the currently open Moon thread intact. Dialog tests cover cancel, one confirm callback, and failure retention. No deployment.

## Contextual highlight controls

Added a 150ms Radix tooltip sharing the menu's dark surface, radius, typography, and shadow. Top/start alignment avoids centering the label across a multiline bounding box. Pointer-opened menus anchor at the actual click; keyboard menus use the first text fragment. Chrome verified a focused Explanation tooltip beside its passage, and distinct Fact (Dig deeper / Check evidence / Add to note) and Explanation (Simplify / Give an example / Add to note) menus. Other kinds have dedicated actions with explicit prompt routing; evidence prompts do not imply unavailable source verification.

The final web suite passed 85 tests and production build passed. The JavaScript entry remains large (approximately 542 kB gzip), recorded for a later performance sweep. A real-browser keyboard check exposed focus loss after Escape on a Markdown annotation; the stable renderer fix is being verified before marking this pass complete.

Final keyboard follow-up: moved Markdown mark rendering to a stable component map, passing menu state through context instead of remounting each mark. A real Streamdown regression and Chrome both confirm Enter focuses Simplify and Escape returns focus to the same Explanation mark. The menu closes and the mark remains the active element. All queued items in this pass are implemented; remaining issues include classification/proposal quality and bundle size, rather than claiming the broader product is finished.

## Corrected thread ownership semantics

The user clarified that explicit thread deletion must also delete its note. Earlier deletion checks correctly described the then-current implementation but preserved notes incorrectly for the product. The revised design treats thread title/note as durable state and messages/turns/interventions as expiring transcript state. Seven days of inactivity preserve the note and its suggestion/history records; explicit thread deletion removes the whole aggregate. The local database preflight found zero note IDs shared across threads, permitting an exclusive-note ownership index without rewriting or deleting existing data. Implementation and deletion/expiry validation follow below.

Ownership correction verified: migration 0007 applied locally. Real SQLite tests execute the actual cleanup SQL and confirm inactivity expiry retains the note, pending suggestions, and thread shell; explicit deletion removes owned notes/history/transcripts and preserves another owner's aggregate. Full API suite passed 108 tests before the final D1 count correction (one live test skipped).

Chrome caught a D1-specific reporting issue: cascade deletes report changes greater than one, so the initial exact-one success check incorrectly returned 409 after a successful commit. Success now accepts positive changes. The batch resolves the currently attached note inside its transaction, avoiding an orphan if a first note appears between preflight and deletion. Eighteen focused tests and typecheck passed afterward.

Final real Chrome deletion of synthetic cactus thread `dc78d41c-9df9-4f6f-b09c-f877ab8b0f27` closed the dialog and returned to “What’s on your mind?” without an error. Scoped D1 counts for its thread, note `30f276e9-4477-40c8-9b32-143564bbbfb2`, messages, suggestions, and edits were all zero. Notes/state/session drafts are evicted and late callbacks cannot restore deleted UI state. Frontend production build passed with the previously recorded bundle warning. No deployment.

## Response toolbar and regeneration

Added compact, tooltip-labeled Highlight, Propose note, Regenerate, and Copy actions beneath finalized assistant responses. Manual classification preserves the old highlight set until a successful replacement and prevents duplicate work. Manual note generation reports an empty result explicitly; pending durable proposals replay without reviving accepted/dismissed suggestions. Propose/Regenerate are limited to the latest completed response. Copy writes response Markdown and shows a checkmark/Copied state.

Regeneration uses the stored preceding user prompt, replaces the latest assistant at its original sequence with a new source message ID only on successful completion, and preserves the old response on failure/cancellation. It does not add a user message or renew inactivity expiry. Preflight latches prevent double-click, Send, navigation, and page-teardown races.

Real Chrome caught and resolved an empty D1 batch on the regeneration path. The failed test left its original answer intact; its specifically identified orphan test turn was marked failed locally before retry. A successful retry on synthetic ice thread `e057ebd9-eeea-4885-9201-466db72aebd3` rendered a new answer with one user and one assistant. D1 confirmed unchanged user ID, assistant replacement `ee11143f-390d-4359-9a2f-5851a7bd5b87` → `ec815aba-7b63-48ee-9b76-130bcef9539e` at sequence 2, and unchanged expiry/activity timestamps. Copy displayed Copied. Manual Propose note displayed an actual partial ghost before completing into a short unsaved edit; Highlight showed an in-flight disabled action while keeping existing marks.

Validation: full web suite passed 88 tests; final frontend build passed with the known bundle warning (approximately 544 kB gzip). API suite passed 111 tests before the empty-batch fix; eight targeted route/regeneration tests and API typecheck passed after it. No deployment.

## Persona footer and Mastra quality pass

The picker now renders the effective selected persona explicitly rather than relying on Radix SelectValue registration. Its trigger and rows share Lucide icons. Chrome verified Mentor in the default footer, icons on both built-in options, and switching to Critical reader updates the footer immediately.

Main-agent context now states when history was omitted and marks incomplete assistant turns without changing stored messages. Core guidance disallows inventing unavailable history, treating partial answers as established conclusions, or claiming tool/source verification without actual support. Existing D1 retention and native Mastra per-step token control remain unchanged.

Secondary classification now requires explicit salience, unique exact non-overlapping quotes, and limits annotation coverage on longer answers. In a real rainbow-mechanism response, one useful explanatory span was highlighted instead of most of the answer. The initial stronger note prompt still proposed a generic recap in that live test; a structured user-originated capture-basis gate now runs before previews/final proposals. Manual Propose note sends an explicit capture request.

Restarted the local frontend on 8788 and API on 8787 after finding both stopped. Wrangler logs and registry use /tmp paths compatible with the workspace permissions; both services returned HTTP 200. API tests passed 115 with one optional live test skipped before the capture-basis follow-up; context regressions and the web build passed.

Final Chrome check on soap-bubble thread `3456bc17-afd0-4649-92a7-49451fa95450`: the three-sentence response streamed, one factual span was highlighted, and the note panel stayed closed. Clicking Propose note then opened a labeled unsaved ghost with Accept/Reject controls. Semantic capture quality remains model-dependent. Effective persona is now shared across display and all request paths, including fallback when Mentor is unavailable. Final focused web tests: 16 passed; secondary-model tests: 19 passed; API/web typechecks and frontend production build passed. Known bundle warning remains (544 kB gzip). Frontend and API left running locally; no deployment.

## Note stream completion and animation follow-up

Investigated disappearing ghosts at completion: stale cached note state could replace the finalized streamed proposal before its canonical state loaded, and first-note adoption also cleared proposal state. Added a hydration guard and removed the redundant adoption reset. A separate server path emitted a valid short preview then returned no proposal if the final text exceeded the concise-edit limit; that now reports an explicit failure rather than a silent empty result. It still refuses unsafe or oversized final edits.

Ghost text now keeps the same CodeMirror widget node while updating and uses a sustained reveal loop across streamed chunks. Per the user's final preference, Accept/Reject controls remain visible throughout; Accept stays disabled until streaming and reveal finish.

Chrome verified a completed manual piano-practice suggestion remains visible after final persistence and browser reload on thread `84c9366b-c1b4-4a8c-aa26-aa915733a577`. An earlier automatic attempt failed at generation and now displayed an error instead of silently disappearing; manual retry succeeded. App/ChatPanel/NotesEditor focused tests: 39 passed, including cancellation signal and ignored late completion; secondary generation tests: 3 passed. Final frontend build/typecheck passed with the known bundle warning. Both local services and the test tab remain open.

Queued edge: cancellation aborts the SSE/model signal and clears local preview, but cancellation arriving exactly during server persistence may still leave a pending suggestion for a later reload. Needs a durable cancellation/decision guard in the later architecture sweep. Also observed the primary agent exposing internal “note suggester” wording in its response; queue prompt-quality correction.

## Native context review

Verified Mastra 1.67 embedded APIs and current official docs. Native TokenLimiter already bounds every model step; added native ToolCallFilter retaining the last two tool-producing steps, without custom tool wrappers. Fixed the guard incorrectly treating every supplied historical user message as required rather than just current request plus note context. Compaction is not enabled: Mastra Observational Memory does not currently support D1. Storage decision requested; details in AGENT-CONTEXT.md.

Closed cancellation-during-validation/persistence behavior with request-created pending cleanup. Replay/concurrent suggestions are protected via created=false from persistence. Focused context/prompt/tool/followup checks passed 48 tests, including the final ownership guard. Also revised primary agent wording to acknowledge clear note requests without exposing internal note-suggester machinery.

Live Chrome follow-up on reading-habit thread `7efc5882-4384-4fc0-9ce3-184d46cecd7e` streamed a response and completed a persistent unsaved ghost. Internal note-suggester language was absent, but the main model still asked unnecessary format questions despite a clear capture request; further agent-quality evaluation remains queued.


## 2026-09-18: D1 observational memory

Native D1 memory now supports Mastra observation/reflection rather than only a 40-message cache. Real engine tests cover observe, reflect, fresh-instance reload and read-only actor retrieval. Live Cloudflare Gemma produced parseable stored observations. Chrome on localhost:8788 recalled the earlier synthetic decision to read for ten minutes before breakfast without accepting the pending note. Initialization/model calls are within the turn deadline; observation receives cancellation through a provider-signal adapter. Lazy expiry now purges unattached-thread messages as well as native memory. No deployment or credential changes.

Queued next: reliably generate concise note proposals, automatic eligibility after explanatory answers, dismissible contextual errors, and shared fast-apply placement that tolerates unrelated typing. See IMPLEMENTATION-ISSUES.md.
