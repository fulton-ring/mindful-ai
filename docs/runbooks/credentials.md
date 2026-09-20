# Credentials and deployment

Local development and deployed environments require Clerk authentication. Keep Clerk development and production instances separate.

## Clerk

Create separate development and production Clerk applications. Enable email verification-code login and Google; leave passwords disabled. Configure allowed redirect URLs for the frontend origin. Set `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and `CLERK_AUTHORIZED_PARTIES` (a comma-separated list of frontend origins) in the API environment. Public frontend configuration is returned by `/api/config`; never send the secret key to the browser.

Test email login followed by Google linking, sign-out, expired tokens, and deletion against the same notes account before launch. Do not merge accounts based on an unverified email string. D1 stores an external identity reference and application records, not login credentials.

## Stripe

Create a recurring personal subscription price in Stripe test mode first. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, and `APP_URL` for the frontend's trusted origin. Register the API billing webhook URL shown in the API routes. Configure subscription lifecycle notifications. Test checkout, cancellation, failed payment, duplicate and out-of-order webhook delivery before enabling production billing. Credentials are intentionally not included in the repository.

## Model provider

The default inference provider is **Cloudflare Workers AI**, using `@cf/google/gemma-4-26b-a4b-it`, as requested by Jeremy. Use the Worker AI binding for deployed inference. Local inference requires Cloudflare authentication and consumes Workers AI usage.

The model supports tool calling, but that does not replace application validation of edits and permissions. Run real conversations covering production, learning consent, incorrect answers, capture, and requests to stop checks before opening access. No OpenAI, Anthropic, or Google API key is required for the Cloudflare-hosted path.

## Cloudflare

The `mindful-ai` D1 database is provisioned and its ID is configured in `apps/api/wrangler.jsonc`. Migrations through `0019_learning_checks.sql` were applied remotely on September 20, 2026 after a schema rehearsal and recovery-bookmark check. Apply subsequent migrations only after checking the target environment. Configure secret values with `wrangler secret put`; do not place them in `vars`, source files, migrations, or CI logs.

Build the web app and API. Verify SPA routing, `/api/*` routing, streaming, auth origins, and scheduled expiration on a staging deployment before releasing it. No remote resources are created by the local setup steps.

### R2 agent files

Mastra accesses Cloudflare R2 through its native S3-compatible filesystem provider. Create a private R2 bucket and an R2 API token restricted to object reads and bucket listing for that bucket. Supply these four values to the API runtime; an R2 Worker binding is not used by this provider:

```dotenv
R2_ACCOUNT_ID=<Cloudflare account ID>
R2_BUCKET=<private bucket name>
R2_ACCESS_KEY_ID=<R2 API token access key ID>
R2_SECRET_ACCESS_KEY=<R2 API token secret access key>
```

All four settings must be present to enable files. A partial configuration fails at runtime instead of silently disabling file access. The application creates a read-only filesystem for each authenticated owner and conversation under `owners/<owner-id>/threads/<thread-id>`, so the model cannot use file tools to write around the note proposal and acceptance flow. Upload files through a separately authorized application path and keep the bucket private.

## Retention

Conversations expire seven days after the last user message. Live reads must enforce expiration even if the scheduled purge has not run. Saved notes remain until deletion. Do not enable raw prompt/response logging in the model gateway or observability tooling. Model-provider retention and D1 Time Travel have separate lifetimes from live-record deletion; document these accurately. After restoring a database, expire stale conversation data before serving requests.

## PostHog observability

Set the Worker secret `POSTHOG_API_KEY` to enable API traces. `POSTHOG_HOST` is optional and defaults to the US ingestion host, `https://us.i.posthog.com`. When the key is absent, API telemetry is disabled. The API exporter always removes message, note, reasoning, tool input/output, request context, and raw error text before export; telemetry includes opaque user, conversation, turn, model, token, timing, and operation metadata only.

For local development, configure these variables in the root environment file, then restart both services:

```dotenv
POSTHOG_API_KEY=<PostHog project key>
POSTHOG_HOST=https://us.i.posthog.com
VITE_POSTHOG_KEY=<same PostHog project key>
VITE_POSTHOG_HOST=https://us.i.posthog.com
```

The frontend key is the public project ingestion key, never a PostHog personal API key. Vite reads the project root environment but only exposes variables prefixed `VITE_`. The active project and runtime configuration are documented below.

Browser analytics use explicit events for navigation, chat lifecycle, note capture and proposal decisions, note-panel controls, persona selection, conversation deletion, and theme changes. Automatic DOM capture and session recordings are disabled. Authentication uses only the opaque Clerk user ID for analytics identity and resets it on logout. Neither interaction events nor Mastra traces include message, note, or reasoning content.

Mastra registers both the main chat agent and the semantic annotator with PostHog observability. Export cleanup runs with Worker `waitUntil`, bounded to 1.5 seconds, and disposes per-turn exporters. Analytics errors must not affect conversation output. Unit tests use mocked exporters; live ingestion verification is documented below.

## Separate application and provisioning credentials

The token in the root `.env` (`CLOUDFLARE_API_TOKEN`) is reserved for application access. Do not use it for provisioning, migrations, or deployment, and do not broaden its permissions for those operations. The deployed Mastra integration uses the native `AI` binding and does not need this token injected into the Worker.

Use the connected Cloudflare MCP for provisioning where supported, or a separate deployment token supplied explicitly to the deployment process. Never load the application's root `.env` into a deployment command. Clerk and Stripe secrets remain separate.

## Wrangler deployment token

Use a custom token restricted to the deployment account:

- Account / Workers Scripts / Edit
- Account / D1 / Edit
- Account / Account Settings / Read
- Account / Workers AI / Read and Edit (local or REST inference checks)
- Account / Workers Tail / Read (diagnostics)

For a separately issued provisioning token, set `CLOUDFLARE_API_TOKEN` only in the deployment process or its CI secret store. Do not commit it. Native deployed inference uses the AI binding and does not require this token as an application secret. The initial workers.dev deployment needs neither Pages nor DNS permissions. A later custom domain additionally needs Zone / Workers Routes / Edit on that zone.

References: https://developers.cloudflare.com/fundamentals/api/reference/permissions/ and https://developers.cloudflare.com/workers-ai/get-started/rest-api/.


## Current deployment

Deployed through the Cloudflare MCP on September 17, 2026:

- URL: https://walden.jeremy-herzog.workers.dev
- Worker: `walden`, serving the React frontend with Workers Static Assets.
- Bindings: `DB` (D1), `AI` (Workers AI), and `ASSETS`.
- Model: `@cf/google/gemma-4-26b-a4b-it` through Mastra and the native binding.
- Scheduled transcript cleanup: `17 * * * *` (UTC).
- Preview URLs are disabled.
- Clerk development authentication is configured and required. Stripe is not configured and billing is disabled by `BILLING_ENABLED=false`.

Verification: public config returned 200; protected notes returned 401; Chromium loaded the setup screen without page errors. Cloudflare rejected the default Python urllib user agent with error 1010, while Chromium and a browser user agent succeeded.

MCP deployment used a Cloudflare-issued, short-lived assets upload session for local asset transfer and the MCP credential for Worker upload and configuration. The application token was not used. Temporary upload-token files were removed after deployment.


## Clerk testing — September 18, 2026

- Clerk CLI 3.3.0 links to application `app_3JU6USCGeA1w4xSM8iiUuMvu96C` (Walden), development instance `ins_3JU6ULlzUU1s7RXDlOQOdTDMs7l`.
- Frontend uses `@clerk/react`; the Hono API validates Clerk Bearer tokens using `@clerk/backend` and checks authorized frontend origins.
- Email verification-code and Google sign-in are enabled; passwords are disabled. The Clerk secret is a Cloudflare Worker secret, never a frontend variable. Fresh credentials were retrieved through Clerk's authenticated Platform API without reading existing environment files.
- `BILLING_ENABLED=false` hides billing navigation and rejects checkout, portal, and webhook requests. No Stripe setup was performed.
- Clerk doctor passed. Local and deployed browser checks covered sign-up controls, Google availability, password absence, and billing disabled. Application data requires a valid signed-in session.
- This is Clerk's development instance; production domain/OAuth setup is a separate launch task.

## Search and PostHog configuration — September 20, 2026

The dedicated US PostHog project is **Walden**, project `619294`:
https://us.posthog.com/project/619294

Set `POSTHOG_API_KEY` to the public `phc_` project ingestion token and `POSTHOG_HOST=https://us.i.posthog.com` in the Worker and local `.dev.vars`. The public `/api/config` endpoint exposes only a `phc_` project token for the browser; personal API tokens are never exposed there. Browser configuration is runtime configuration, so a separate Vite analytics key is no longer required.

The browser emits standard `$pageview` events, including signed-out visits, with thread paths normalized and query strings removed. Existing explicit chat/note events require an authenticated identity. Autocapture, session recordings, and surveys remain disabled. Server traces preserve model, token, duration, tool, and opaque correlation metadata, with prompt/answer/tool contents removed.

Live local verification confirmed pageviews, chat submission/completion, and `$ai_generation`, `$ai_span`, and `$ai_trace` ingestion. An aggregate check of 389 trace events found no populated input, output, output-choice, state, or tool-content fields. Search subrequests incur separate OpenRouter usage; main generation token counts do not include those subrequests.

`OPENROUTER_API_KEY` is also required in the deployed Worker for public web search. This does not change `AI_PROVIDER=cloudflare` for the main model. Keep the secret out of source and logs.
