# Implementation follow-up log

> Current bounded work is tracked in [ACTIVE-QUEUE.md](./ACTIVE-QUEUE.md).

This log separates credential-dependent verification and product decisions from the working local implementation. It is updated during the integration sweep.

## Current local status (supersedes historical entries below)

- Older-response branching and real Browser Run → AI Search retrieval have been verified in Chrome; they are no longer queued implementation work.
- Add to note and Propose note share proposal SSE, inline ghosts, persistence, and decision history. Add preserves selected text and automatically accepts; Propose waits for approval. The separate capture feedback card is removed.
- Chrome verified Add acceptance, Undo restoring its ghost, reload persistence, and manual Propose on the same older response. A further pass typed into an unrelated paragraph during generation, closed/reopened the panel, clicked the ghost and pressed Tab: acceptance preserved the concurrent typing.
- Model prompt contradictions about copied anchors were removed. Numbered block placement supplies exact anchors server-side; generated additions trim surrounding whitespace, while explicit captures preserve their supplied text. A live no-proposal preference check passed.
- Acceptance/history mutations briefly disable editing while saving. Their responses now check conversation, branch, and note identity before changing the active view, preventing a late response from affecting another branch. Focused App tests cover those identity guards; an actual delayed network/branch-switch browser case remains unverified.
- First-note-on-fork verification passed in Chrome: a new automatic ghost opened the note, acceptance saved it, and the selected branch URL plus four-message history remained intact.
- Conflicting manual capture now retains the pending ghost and asks the user to accept/reject it first. Chrome verified this leaves the pending text unchanged and commits neither selection. API rejects same-source conflicting capture before inference. Final SSE delivery failure cleans up only the newly created pending row; 32 follow-up tests pass, including forced enqueue failure.
- Remaining local browser matrix: close/reopen during active generation, reload during active generation, cross-tab revision conflicts, typing over an arriving ghost, cancellation during unified capture, and smooth animation under live inference. Earlier successful completed-ghost tests do not prove these cases.
- A live fictional capture response redundantly asked whether to save after the user had explicitly requested saving; its secondary proposal did correctly appear. Main-agent wording should acknowledge an explicit save request without asking for authorization again.
- Keep deployment and Stripe setup deferred as requested. Local services remain running.

### Cross-tab recovery investigation

Chrome reproduced a real revision conflict: tab A accepted a ghost while tab B edited the first paragraph. B retained its local text and showed Changed elsewhere; A's committed content remained intact. However, Reload remote note restored B's session-cached text with the new server revision, leaving it Unsaved and capable of overwriting A on a subsequent save. This is a draft restoration bug, not a D1 revision-check failure. Recovery needs cached base revisions, a real remote-load action, and export of the local unsaved draft (the normal API export contains only committed text).

Corrected locally: cached drafts now retain their base revision and provenance; stale or unknown-base drafts restore as conflicts. The explicit Load latest note action fetches canonical state and clears the active local cache only after success. Download my draft exports local text. Chrome verified stale-draft reload remains conflicted, loading latest restores the other tab's accepted paragraph, and another reload preserves that result. Download file contents were not separately inspected in-browser. Late ordinary-save responses also have route/note ownership guards. App regression suite: 22 passing tests.

## External verification after credentials

- Clerk: verify actual email/Google sign-in, identity linking, logout/revocation, and account deletion.
- Stripe: verify signed webhook delivery, subscription lifecycle, and replay behavior with test credentials.
- Model provider: run the behavioral evaluation set against the configured real tool-capable model.
- Cloudflare staging: verify the full Worker bundle, D1 migrations, hosted authentication origins, scheduled cleanup, and streaming on a deployed environment.
- MCP: exercise a configured HTTPS server and its real tool schemas. Do not enable irreversible integrations without an application-owned classification and confirmed arguments.

## Product decisions

- Provider/model is confirmed: Cloudflare Workers AI, Gemma 4 26B A4B. Final token/cost budgets still need live measurement.
- Final price and free/paid usage limits (planning defaults are not a published offer).
- Verifiable carbon accounting requires provider evidence; report unavailable values honestly.
- Pilot continuation thresholds remain proposals; record the final thresholds before collecting the pilot cohort.

## Deferred by the V1 spec

No collaborative editing, model picker, vector memory, background dreaming, spatial canvas, or consciousness-points system.

Conversation context remains application-owned in D1. Native Mastra memory now reconciles that transcript into D1-backed observational memory; main-agent writes, working memory, semantic recall, and automatic titles remain disabled. Observation/reflection are thread-scoped and are deleted with explicit thread deletion or transcript expiry. A native Mastra token limiter provides a 48,000-token final guard on every model step, including tool continuations. If trimming would remove the note context or current request, the turn fails instead of silently continuing with incomplete context.

Conversation expiry is enforced on reads after seven days of inactivity. Purging is also performed when an expired linked conversation is loaded, so expired rows can remain physically present until scheduled cleanup or a later access; D1 Time Travel and model-provider retention have separate lifetimes.

## Known implementation gaps

- MCP tools are limited to operator-allowlisted read-only actions. Confirmed write actions and compensation are not implemented.
- Final note suggestions and accept/dismiss decisions now persist separately from committed notes. Toolbar and editor shortcuts use the same server-backed undo/redo history, including restoration of dismissed suggestions. In-progress model previews remain provisional until generation completes.
- Account deletion records a pending state when Clerk deletion fails, but has no scheduled retry processor yet.
- Product events are collected; cohort reporting queries and pilot dashboards remain to build.
- TanStack Router owns `/` and `/conversations/$conversationId`. Settings alone uses local modal state; opening and closing it leaves the browser URL unchanged, as verified in Chrome.
- The initial frontend bundle includes Clerk and CodeMirror together; split loading in a later performance sweep.
- Live Cloudflare MCP inference returned a valid Gemma note-edit tool call. The complete deployed Mastra streaming flow still needs staging verification.
- The application Cloudflare token is used only by the configured runtime REST transports. Provisioning remains separate. Local Browser Run and AI Search do not require Wrangler OAuth: complete REST credentials select both REST APIs, while native bindings remain the deployment fallback.

## Local chat-first correction

The September 18 correction supersedes the initial note-first entry flow. New conversations have no note until the user creates one or accepts a capture. The local schema migration makes conversation note links optional and preserves child records. This migration has not been applied remotely. Do not deploy the new API against the old remote schema without an explicitly authorized migration/deployment step.

Local validation of the chat-first correction passed: API chat without a note, note attachment preserving messages, conversation deletion preserving notes, accepted capture preserving agent provenance, keyboard sidebar resizing, and mobile drawer behavior. The normal header was removed; account controls live in the sidebar. No remote migration or deployment was performed for these changes.

## Conversation workspace follow-up

The sidebar now lists conversations only. Their attached notes reopen with them; expired note-linked conversations remain available with empty transcripts, and a new message renews the same conversation with note context. Scheduled cleanup removes expired messages, turns, and interventions while retaining the note link. Manual note creation, the close-chat control, and highlight toggle/tool were removed. Notes are created through accepted captures. The default persona is Mentor, editable through Settings. Text-selection actions are anchored to the selected passage and dismiss when selection clears or the user clicks elsewhere.

Local real inference through Mastra and Cloudflare REST credentials was verified using Gemma 4 26B A4B. The existing application token is loaded by Wrangler at runtime; no deployment or provisioning was performed. The ordinary unit suite skips the separately verified credential-gated inference test.

Deletion semantics were clarified: explicit thread deletion removes its note, note suggestions/history, and transcript. Inactivity expiry removes only transcript state, retaining the thread and note for future questions. A thread owns its note exclusively; migration 0007 prevents sharing a note across threads. The earlier note-preserving deletion behavior above is superseded.

## Composer, navigation, and inline review follow-up

The composer uses a plus-triggered Radix/shadcn-style persona select; the selected persona replaces the plus. Shared controls use Tailwind tokens/utilities and Lucide icons, with left-aligned sidebar actions and subtle composer focus styling. Themes are labeled Light and Dark. TanStack Router owns the home and conversation URLs. Settings alone opens as a local modal without changing the URL; the earlier `/settings` and `returnTo` route description is obsolete. Settings lists persona descriptions with edit/delete controls; built-ins can be hidden per owner via migration 0003 and custom personas deleted.

Open note sits in the chat's top-right corner. The note panel starts closed, opens for existing linked notes or incoming proposals, and respects explicit dismissal for the conversation. Record proposals render as inline edits in the note panel, including an unsaved first-note preview; acceptance creates the saved note. Selection actions are Challenge, Dive deeper, and Add to note.

Remaining authenticated browser verification on localhost:8787 should cover selector alignment, focus styling, inline proposal cancellation and unresolved concurrency cases, panel dismissal behavior, persona deletion persistence, mobile note navigation/draft preservation, sidebar wheel scrolling with real overflow, and a real `searchSources` activity/source cycle. Do not run destructive fixture cleanup against a workspace in manual use.

## Note interaction status after D1 observational memory (2026-09-18)

The principal reported failures are corrected locally. Chrome verified a finance capture with immediate text feedback and relevant placement under Bonds, a concise automatic ghost bullet, click and Tab acceptance (including Tab after reload), typing-over dismissal, and undo restoration. Heading/schema echo failures are fixed. Canceling explicit capture during placement was verified to leave the note unchanged; the broader concurrency matrix in `NOTE-UX-RESET.md` is still open.

## Queued after note generation and safe placement

- Regenerating an older assistant response creates a branch within the thread. Preserve the original branch and its downstream messages; define branch selection/navigation and branch-scoped model history before implementation.

## Current verification (2026-09-18, note recovery)

The live failure was reproduced: an explicit UI proposal produced 63 words/442 characters and repeated the same oversized text on repair. The prompt ambiguously exempted explicit captures although validation only exempted verbatim Add to note. Instructions now distinguish the action from captureBasis, apply the actual hard limits, and target a shorter single takeaway. Chrome verified a real Gemma proposal, reload restoration, and Tab acceptance into a saved note. Contextual retry/dismiss, safe concurrent rebasing, and shared capture placement have focused passing tests. Older completed responses now expose Propose note; their source message is revalidated before persistence against the current note. Branching regeneration remains queued.

Code Mode is excluded. Browser Run and AI Search use direct tools; see `runbooks/research.md` for the current transport and verification boundary. No application deployment was performed.

Automatic generation also verified in Chrome: after a new completed response describing the FDIC-insurance decision, classification appeared and a concise ghost bullet was placed beside the existing account-selection criteria without clicking Propose note. A separate schema-echo failure was corrected by using native Cloudflare structured output (`jsonPromptInjection: false`) for note generation; focused generator tests assert that setting. Existing-note anchor repair was verified live.

## Cloudflare research tools (2026-09-18)

Implemented direct Browser Run page reading and owner-scoped AI Search indexing/retrieval. Code Mode is explicitly excluded. With account ID and application token present, both services use REST; native bindings are the deployment fallback. Local development stays on `--local`, avoiding the unavailable edge-preview path, and does not require Wrangler OAuth. Chrome verified a real page read, queued index acknowledgement, completed compact tool control, source disclosure hyperlink, inline Markdown citation, and persistence of the one activity and one source after reload. A real `searchSources` browser run is still pending. See `runbooks/research.md` for startup, data retention, same-origin limitations, and verification boundaries.

## Historical note feedback

The earlier silent Add-to-note delay and stale “No note edit was suggested” behavior drove the replacement interaction. Immediate capture text, stable proposal identity, relevant placement, and repeat-attempt handling are now implemented and have focused browser coverage. Remaining cancellation, concurrency, reload-during-generation, and delete-then-retry cases live in the acceptance matrix in `NOTE-UX-RESET.md`; they are not duplicated as a separate implementation queue here.

## Native tool activity and sources (2026-09-18)

Abbreviated tool activity and source disclosure are implemented using Mastra structured events, durable message metadata from local migration `0009_message_activity.sql`, and compact AI Elements-style disclosures. Raw arguments/results are not rendered. Automated validation currently reports API 193 passed/3 skipped, web 56 passed, plus the focused stream test passing. Chrome verified the `readWebPage` lifecycle and reload persistence: one completed control and one source remained, alongside the inline Markdown citation. The equivalent real `searchSources` browser flow remains pending.

Migrations `0008_repeat_note_suggestions.sql` and `0009_message_activity.sql` have been applied to local D1 only. Remote migration and deployment remain separate authorized operations.

Sidebar scrolling was verified with real overflowing content and keyboard scrolling in Chrome; the footer stayed fixed. Settings persona editing and its custom tone dropdown were also exercised without changing the thread URL.

## Research permission diagnosis

Direct runtime-token checks supersede the earlier model-reported queued acknowledgement: AI Search search succeeds (200), item upload/list fail (403), and the index is empty. User updated permissions; initial rechecks still failed. Failed indexing now carries an explicit safe reason and a tool summary, without losing the successfully read page or citation. Focused research/agent checks: 19 passed, 1 opt-in live test skipped. Indexed retrieval remains outstanding.

Permissions update verified: application-token upload and owner-filtered retrieval both returned 200 for a temporary synthetic document; it was removed after verification. Browser integration verification remains outstanding. Local migration0010 is applied after fixing orphan suggestion backfill; branch runtime validation is in progress.

## Branch and research browser pass

Older-response regeneration now creates a durable selectable branch, preserving original downstream messages. Chrome verified original path16messages/newpath2messages, URL selection, reload, shared note, continuation to4messages, and real AI Search retrieval with citations. The default-URL cache bug found during this pass is fixed with mounted-key updates plus canonical branch-key updates. Exact user-reported Add to note placement now succeeds through numbered-block selection; see NOTE-UX-RESET.md. Remaining UX issues include automatic-proposal echo/ignoring a no-note request, and the remaining live concurrency/cancellation matrix. Old queue entries above are historical and superseded by this evidence.
