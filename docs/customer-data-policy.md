# Customer data use

Implemented locally September 20, 2026. Operator: Fulton Ring; privacy contact: info@fultonring.com.

## Default and collection boundary

Help improve Walden starts on in a first-use notice. The server captures nothing until the account acknowledges the current disclosure. Users can turn it off before continuing or later in Settings → Account. The account preference applies across devices. Browser analytics has its own browser-local control.

Collect only new user messages and visible replies, limited to 24,000 characters each. Replies can repeat older messages or note material; this is disclosed. Do not export old transcripts, raw model prompts, note context, memory, hidden reasoning, tool payloads, or arbitrary request context. Mastra continues to send content-free operational diagnostics for chat, annotations, and note proposals.

Purpose: troubleshooting, authorized human review, quality evaluation, and development/improvement of Walden features. Excludes model training/fine-tuning, sale, advertising, publication, and unrelated third-party research. Credential/email redaction is best-effort, not anonymization. Do not copy conversations into indefinite evaluation datasets or issue trackers; prefer synthetic regression examples.

The server reads the preference at turn start and again before export; a changed preference discards the in-flight exchange even if sharing was turned back on. An already transmitted request cannot be recalled. Consent version, first acknowledgement, and latest change time and revision are stored with the account and included in export. Account deletion immediately suppresses new content capture and durably queues provider deletion before removing identity or application records.

## PostHog

Visible exchanges are `$ai_trace` events with `$ai_input_state` and `$ai_output_state`, grouped by `$ai_session_id` (conversation). They do not duplicate inference token/cost counts. Raw Mastra traces remain separate, linked through the same conversation ID and turnId. Look for **Visible conversation** in AI Observability → Traces/Sessions.

PostHog documents 30-day retention for these content fields. Metadata has separate project retention. Restrict access to customer content; review vendor agreements and regional processing requirements before public release. No secondary AI analysis or third-party LLM evaluations are enabled by this change.

## Deployment requirements

1. Initialize fresh databases with the Drizzle-generated `0000_baseline.sql`, which includes privacy, persona icons, and web-search preferences. Use incremental generated migrations for future changes.
2. Configure your own POSTHOG_API_KEY and POSTHOG_HOST for ingest. Set POSTHOG_PROJECT_ID to your project ID and POSTHOG_PERSONAL_API_KEY as a Worker secret scoped to that project's `person:write`. These management credentials are separate from the public ingest key.
3. The existing hourly scheduled Worker retries `telemetry_deletions`. It waits at least ten minutes after an account deletion request, allowing request-owned generation/flushes to end, then calls PostHog bulk deletion by distinct ID with events and recordings included. Provider acceptance is asynchronous, not proof of physical erasure. Inspect provider deletion status for privacy requests. Failed/unconfigured requests stay in D1 for retry; Detailed conversation capture fails closed until the management key and project ID are configured. Configure and verify this path before enabling content collection.
4. Verify deployed privacy notice, preference persistence, synthetic content delivery, opt-out, and provider deletion with a disposable test account. Never delete a real customer for testing.
5. Policy pages now identify Fulton Ring and the contact address. Have counsel review jurisdiction-specific eligibility, lawful bases, international transfers, cookie consent, and consumer terms before a broad launch. Product controls alone do not establish legal compliance.

## Sources

- https://posthog.com/docs/ai-observability/data-retention
- https://posthog.com/docs/ai-observability/privacy-mode
- https://posthog.com/docs/api/persons
- https://posthog.com/docs/data/events-retention
- https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/guidance-on-ai-and-data-protection/how-do-we-ensure-lawfulness-in-ai/
