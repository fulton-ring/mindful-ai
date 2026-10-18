# Walden

A chat-first workspace for thinking with an assistant. Create notes during a conversation when you have something you want to keep. Notes stay; conversations expire after seven days of inactivity. Suggested edits are reviewed inline before they become part of your document.

## Self-hosting

Run Walden as one container with SQLite, or use PostgreSQL, Valkey and S3 with separate runtime roles. See the [self-hosting guide](docs/self-hosting.md), [Compose configuration](compose.yaml), and [Kubernetes chart](deploy/helm/walden/README.md). No Cloudflare account is required for the self-hosted runtime.

## Development

Requires Node.js 24.15+ and pnpm 10.30.0.

```sh
pnpm install
pnpm dev
```

Open **http://localhost:3000**. The default development server runs the standalone Node API with SQLite and local files in `.data/`. Vite proxies `/api` and `/health` to its internal API on port 3001. Startup applies local migrations, prepares the pinned MiniLM embedding model and matching Chromium, and builds shared packages before starting source watchers. The first run needs network access; subsequent runs reuse the downloaded assets.

The launcher loads the repository-root `.env` and preserves your auth, inference and storage settings. Without authentication configuration, the local instance uses one shared default account. Notes work without an inference provider; configure `AI_PROVIDER` and its model/credentials to enable chat. See [the configuration examples](docs/self-hosting.md#configuration). Only `VITE_` variables are exposed to browser code.

See [the adapter guide](docs/adapters.md) for the shared application and runtime boundaries. `pnpm test:dev` checks launcher/proxy configuration; `pnpm test:dev:smoke` starts a disposable instance on spare ports and verifies API hot reload and shutdown.

Keep `.data/` to preserve local notes and conversations. `DATA_DIR` selects another directory. `PORT` changes the public Vite port, `WALDEN_API_PORT` changes the internal API port (default: `PORT + 1`), and `APP_URL` must match the public browser origin. For example: `PORT=4200 APP_URL=http://localhost:4200 pnpm dev`.

For the Cloudflare adapter, use the explicit legacy workflow:

```sh
cp apps/api/.dev.vars.example apps/api/.dev.vars
# Configure Clerk and inference credentials in apps/api/.dev.vars.
pnpm db:migrate
pnpm dev:cloudflare
```

Open **http://localhost:5173** for frontend hot reload; Wrangler serves the API on 8787 and uses its own local D1 state. This mode retains the Clerk and Cloudflare binding requirements. Cloudflare browser reading and AI Search use remote bindings and need authenticated Wrangler access (`pnpm --filter @walden/api exec wrangler login`). Use this mode when validating Cloudflare behavior.

## Database schema

Edit `apps/api/src/db/schema.ts`, run `pnpm db:generate`, review the SQL, then apply it with `pnpm db:migrate`. See the [database workflow](docs/database.md) for test and production commands.

## Workspace

- `apps/web`: React/Vite interface, CodeMirror editor, TanStack Query state.
- `apps/api`: Hono API with Node and Cloudflare adapters, persistence, authentication, Mastra orchestration and services.
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
