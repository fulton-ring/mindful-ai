# Credentials and deployment

Walden is a [Fulton Ring](https://fultonring.com) product. This guide covers configuring your own deployment.

Use your own service accounts and resources. Keep secrets in the root `.env` for standalone development, `apps/api/.dev.vars` for Wrangler development, or the deployment platform's secret store. Never commit credentials or print private deployment profiles in CI logs.

## Standalone development and self-hosting

`pnpm dev` starts the app at `http://localhost:3000`, backed by SQLite and local files. No Cloudflare or authentication provider is required. Without auth configuration, one shared default account owns the workspace; `AUTH_MODE=none` explicitly selects that behavior. See [self-hosting](../self-hosting.md) for container, PostgreSQL, Valkey and S3 settings.

Choose optional authentication before exposing a private workspace:

- `AUTH_MODE=better-auth`: configure `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` for your public app origin, plus any desired OAuth providers. The standalone runtime can default the auth URL from `APP_URL`.
- `AUTH_MODE=clerk`: configure your own `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and comma-separated `CLERK_AUTHORIZED_PARTIES` frontend origins. Keep development and production Clerk instances separate. The API returns public browser configuration from `/api/config`; the secret key stays server-side.

Changing an existing database's auth mode requires explicit operator acceptance; see the self-hosting guide. Verify sign-in, sign-out, account isolation and deletion with disposable accounts.

## Inference and research providers

Notes work without inference credentials. To enable chat, explicitly choose `AI_PROVIDER` and configure its connection:

- `cloudflare`: use the native Worker `AI` binding, or your own `CLOUDFLARE_ACCOUNT_ID` and application `CLOUDFLARE_API_TOKEN` for REST access.
- `openrouter`: set `OPENROUTER_API_KEY` and optionally `AI_MODEL`.
- `openai-compatible`: set `AI_BASE_URL`, `AI_MODEL`, and `AI_API_KEY` if the endpoint requires it.

`AI_MODEL` selects the default model; `AI_BACKGROUND_MODEL` and `AI_MODELS_JSON` can constrain background work and the available catalog. Select models that support the application's text and tool use. Provider usage and retention depend on your account and endpoint.

`OPENROUTER_API_KEY` separately enables public web search. Standalone page reading and saved-source indexing use the local browser and index. Cloudflare page reading and saved sources require your own browser/search bindings or REST credentials and `AI_SEARCH_INSTANCE`. See [research setup](research.md).

## Cloudflare development and deployment

The tracked `apps/api/wrangler.jsonc` and `apps/landing/wrangler.jsonc` are portable examples. They select no account or production domains. Authenticate Wrangler to your own account, create D1 and R2 resources, and replace the all-zero `database_id`. Retain the binding names (`DB`, `FILES`, `CHAT_TURN`, `AI`, `BROWSER`, `AI_SEARCH`, `ASSETS`), SQL text rule and existing Durable Object migration tag when adapting the app profile. Remote AI, browser and search bindings need your own account access even during local Wrangler development. The configured 30-second CPU limit requires Workers Paid.

For local Cloudflare development, copy `apps/api/.dev.vars.example` to `.dev.vars`, configure your chosen auth/inference settings, then run `pnpm db:migrate` and `pnpm dev:cloudflare`. The frontend runs on 5173 and Wrangler on 8787. See [database workflow](../database.md) for schema changes.

For each deployment, copy the portable examples to ignored `wrangler.production.private.jsonc` files beside the originals and configure your own account ID, resource IDs, bindings, vars and optional custom-domain routes. Keep each profile private with file mode `0600`. Production auth belongs in the private profile and its Worker secrets; the tracked example intentionally uses `AUTH_MODE=none`.

Set Worker secrets using the appropriate profile, for example:

```sh
pnpm --filter @walden/api exec wrangler secret put CLERK_SECRET_KEY --config wrangler.production.private.jsonc
```

Use a deployment token with only the Cloudflare permissions needed for your resources and routes. Keep it separate from application REST credentials. Do not load the application's root `.env` into deployment commands. Native Workers AI inference does not need a deployment token injected into the Worker.

Build and inspect before deploying:

```sh
pnpm build
PUBLIC_APP_URL=https://chat.example.com PUBLIC_SITE_URL=https://example.com pnpm --filter @walden/landing build
pnpm --filter @walden/api exec wrangler deploy --dry-run --config wrangler.production.private.jsonc
pnpm --filter @walden/landing exec wrangler deploy --dry-run --config wrangler.production.private.jsonc
```

When explicitly releasing, omit `--dry-run` for the selected private profile. Verify auth origins, `/api/*`, SPA routing, streaming and scheduled cleanup on your own staging deployment first. Builds and dry runs do not upload or provision resources.

### GitHub production deployment

The manual CI deployment jobs require successful verification and standalone integration checks on `main`. Configure the GitHub `production` environment with:

- Secret `CLOUDFLARE_API_TOKEN`: the deployment token.
- Secret `WALDEN_APP_WRANGLER_CONFIG`: the exact raw JSONC contents of your private API profile.
- Secret `WALDEN_LANDING_WRANGLER_CONFIG`: the exact raw JSONC contents of your private landing profile.
- Variable `WALDEN_PUBLIC_APP_URL`: your app origin.
- Variable `WALDEN_PUBLIC_SITE_URL`: your landing-page origin.

The jobs fail when required configuration is missing. Each job writes its profile with mode `0600` and passes it directly to Wrangler. Landing builds receive both public URLs; local landing defaults are `http://localhost:3000` for app links and `http://localhost:4321` for the canonical site URL. Worker secrets remain managed separately from the JSONC profiles.

### R2 attachments

Bind your private bucket as `FILES`. Browser uploads through R2 require `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`; store the access keys as Worker secrets. Adapt `apps/api/r2-cors.json` to your actual browser origins before applying it. Add a lifecycle rule removing abandoned `staging/` objects after one day. Local Wrangler development can use `UPLOAD_LOCAL_FALLBACK=true` instead of browser presigned URLs. See the self-hosting guide for standalone local-file/S3 configuration.

## Optional PostHog

Telemetry is disabled without `POSTHOG_API_KEY`. Configure your own project ingestion key and optional `POSTHOG_HOST` (default `https://us.i.posthog.com`). `/api/config` exposes only a public `phc_` ingestion key for browser analytics; never use a personal management key there. Browser autocapture and session recording are disabled.

Content-free operational traces and explicitly consented visible-conversation capture have different boundaries. Detailed capture fails closed without `POSTHOG_PROJECT_ID` and `POSTHOG_PERSONAL_API_KEY` for deletion management. Keep the personal key server-side and verify opt-out and provider deletion before enabling collection. See [customer data policy](../customer-data-policy.md) for disclosure, retention and deletion requirements.
