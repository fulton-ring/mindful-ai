# Walden

A chat-first workspace for thinking with an assistant. Create notes during a conversation when you have something you want to keep. Notes stay; conversations expire after seven days of inactivity. Suggested edits are reviewed inline before they become part of your document.

## Development

Requires Node.js 22.13+ and pnpm 10.30.0.

```sh
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
pnpm db:migrate
pnpm dev
```

The frontend runs on Vite and proxies `/api` to the local Cloudflare Worker. Local use requires Clerk authentication and either Cloudflare Workers AI credentials or an AI binding. Authentication fails closed when it is not configured.

`pnpm dev` respects `AI_PROVIDER` and `AI_MODEL` from the environment files; it does not override the configured provider. Use Cloudflare inference when validating production behavior.

`pnpm dev` builds the shared contracts and domain packages before starting the app, then keeps their `dist/` output updated with native TypeScript watch tasks. Vite and Wrangler consume those emitted files during development.

Use **http://localhost:5173** while developing the web app. Wrangler serves the
worker and a *prebuilt* copy of `apps/web/dist` on :8787, so front-end edits do
not appear there until the next `pnpm build`; :5173 is the Vite server with hot
reload and proxies `/api` to the worker.

Web reading and source search (`readWebPage`, `searchSources`) use the Cloudflare
browser and AI Search bindings. Neither has local emulation, so both are declared
`remote` and need an authenticated Wrangler: run `npx wrangler login` once. Until
you do, the two tools are simply not registered, and the assistant is told it has
no web access so it says so rather than offering to look things up.

## Workspace

- `apps/web`: React/Vite interface, CodeMirror editor, TanStack Query state.
- `apps/api`: Hono Worker, D1 persistence, Clerk verification, Mastra orchestration, service adapters.
- `packages/contracts`: shared request validation and wire types.
- `packages/domain`: text edits, authorship, and retention rules.

Turborepo orders workspace tasks. Biome checks and formats source files.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm lint
pnpm lint:fix
```

Builds do not deploy. Live providers and hosted services require their own credentialed smoke checks.

See [the implementation plan](docs/superpowers/plans/2026-09-17-walden-v1.md), [credential setup](docs/runbooks/credentials.md), and [follow-up log](docs/IMPLEMENTATION-ISSUES.md).

## Hosted environment

https://mindful-ai-api.jeremy-herzog.workers.dev

The Worker, frontend assets, D1 schema, AI binding, and cleanup schedule are deployed. Clerk sign-in is required and supports email verification codes and Google using the linked development instance. Billing is disabled behind `BILLING_ENABLED=false`; Stripe is not configured. See the credential runbook for the remaining setup and keep application credentials separate from provisioning credentials.

Chat requires **Workers Paid**. Workers Free can terminate Mastra chat and annotation requests for exceeding CPU time, leaving an interrupted response. On 2026-09-20 this was reproduced in production; a request was killed at about 2 seconds of CPU. Local Wrangler does not reproduce that production limit. Upgrade the account's Workers plan before treating signed-in chat as ready for use.

Interrupted transports attempt to cancel their own turn before unlocking the composer. A persisted streaming turn older than 90 seconds is recoverable even when a terminated request left an in-memory controller behind. This is recovery from failure, not a substitute for sufficient runtime capacity.

## Local-first evaluation

Continue development and evaluation locally. Do not deploy changes without an explicit request.

A test Worker can use its own local D1 database. Browser tests require Clerk authentication and configured model inference:

```sh
pnpm build
cp apps/api/.dev.vars.test.example apps/api/.dev.vars.test
pnpm --filter @walden/api db:migrate:test
pnpm --filter @walden/api dev:test
# In another terminal:
E2E_BASE_URL=http://localhost:8788 pnpm exec playwright test chat-first
```

The test environment keeps billing disabled. All application routes require a signed-in Clerk user.
