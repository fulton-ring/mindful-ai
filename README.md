# Walden

A chat-first workspace for thinking with an assistant. Create notes during a conversation when you have something you want to keep. Notes stay; conversations expire after seven days of inactivity. Suggested edits are reviewed inline before they become part of your document.

## Self-hosting

Run Walden as one container with SQLite, or use PostgreSQL, Valkey and S3 with separate runtime roles. See the [self-hosting guide](docs/self-hosting.md), [Compose configuration](compose.yaml), and [Kubernetes chart](deploy/helm/walden/README.md). No Cloudflare account is required for the self-hosted runtime.

## Development

Requires Node.js 24.15+ and pnpm 10.30.0.

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

## Database schema

Edit `apps/api/src/db/schema.ts`, run `pnpm db:generate`, review the SQL, then apply it with `pnpm db:migrate`. See the [database workflow](docs/database.md) for test and production commands.

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

See [credential setup](docs/runbooks/credentials.md). Completed plans and work logs are kept in [docs/archive](docs/archive/README.md).

## Hosted environment

https://walden.jeremy-herzog.workers.dev

The Worker, frontend assets, D1 schema, AI binding, and cleanup schedule are deployed. Clerk sign-in is required and supports email verification codes and Google using the linked development instance. See the credential runbook for the remaining setup and keep application credentials separate from provisioning credentials.

Chat requires **Workers Paid**. Workers Free can terminate Mastra chat and annotation requests for exceeding CPU time, leaving an interrupted response. On 2026-09-20 this was reproduced in production; a request was killed at about 2 seconds of CPU. Local Wrangler does not reproduce that production limit. Upgrade the account's Workers plan before treating signed-in chat as ready for use.

Each chat turn runs in its own Durable Object, not in the request that started it. A dropped connection only detaches the client; it reattaches through the turn's event stream, and Stop cancels the turn. A turn has a 15-minute budget. A deploy or restart mid-turn ends the reply as interrupted, keeping what streamed, with Try again.

## Local-first evaluation

Continue development and evaluation locally. Do not deploy changes without an explicit request.

A test Worker can use its own local D1 database. The test Worker still needs Clerk keys (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`) in `apps/api/.dev.vars.test`; there is no authentication bypass.

```sh
pnpm build
cp apps/api/.dev.vars.test.example apps/api/.dev.vars.test
pnpm --filter @walden/api db:migrate:test
pnpm --filter @walden/api dev:test
# In another terminal:
pnpm exec playwright install chromium
E2E_BASE_URL=http://localhost:8788 pnpm test:e2e
```

Without further setup only the signed-out spec runs. The signed-in specs (`chat-first`, `workspace`) are skipped unless `E2E_STORAGE_STATE` points at a saved Clerk session for the test Worker, for example one saved with `pnpm exec playwright codegen --save-storage=.auth/e2e.json http://localhost:8788`, and the test Worker has model inference configured. They clean up only the threads and notes they create.
