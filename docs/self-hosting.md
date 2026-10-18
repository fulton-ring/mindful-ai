# Self-hosting Walden

Walden is an open-source product by [Fulton Ring](https://fultonring.com).

The same OCI image serves the UI and API, runs durable chat execution, extracts PDF/DOCX/XLSX attachments, reads public web pages with Chromium and searches saved sources using a bundled local embedding model. A standalone instance stores its database and private objects in one persistent volume. PostgreSQL, Valkey and S3 support separate HTTP, worker and scheduler processes. Neither setup requires a Cloudflare account.

Use Node.js 24.15 or newer and pnpm 10.30.0 when building outside Docker. The image pins the Node 24.15 Debian baseline and uses Debian's Chromium distribution, tested with the installed Playwright adapter on both supported architectures. The build downloads the pinned embedding model; runtime startup does not download model weights. Model assets and the UI are included in the image. Provider credentials are runtime configuration, never build arguments.

## One container with SQLite

```sh
cp deploy/self-hosted.env.example .env.self-hosted
# Configure an inference endpoint/model in .env.self-hosted to enable chat.
docker compose up --build -d app
curl --fail http://localhost:3000/health/ready
```

Open http://localhost:3000. The example binds only to loopback. Without authentication configuration, Walden uses one persistent default account; everyone who reaches that instance shares that account. Configure authentication before exposing the port publicly. A populated protected instance refuses a silent switch to unauthenticated access.

`walden-data` holds `/data/walden.sqlite` (application data), `/data/mastra.sqlite` (Mastra memory and execution state), `/data/execution-cache.sqlite` (local replay/coordination cache), and `/data/files` (private objects). Preserve the entire volume. Every Node role applies pending versioned migrations before serving traffic or starting execution. SQLite write locks and PostgreSQL migration locks serialize concurrent startup; checksums reject changed migration history. The default `APP_ROLE=all` also starts execution recovery and runs the retention scheduler. Do not run multiple independent SQLite containers against this volume. `docker compose down` preserves it; `down --volumes` deletes it.

The provided Compose file supplies Chromium's non-root seccomp profile and shared memory. For direct Docker use:

```sh
docker build -t walden:local .
docker run -d --name walden \
  --security-opt no-new-privileges:true \
  --security-opt seccomp=deploy/docker/chromium-seccomp.json \
  --cap-drop ALL --shm-size 512m \
  --env-file .env.self-hosted --publish 127.0.0.1:3000:3000 \
  --volume walden-data:/data walden:local
```

Chromium's sandbox remains enabled. The host must permit unprivileged user namespaces; follow the [Playwright container guidance](https://playwright.dev/docs/docker) when choosing a host security profile. The supplied profile derives from the upstream Playwright v1.64.1 Docker profile, with `chroot` permitted for Chromium’s private user namespace while host capabilities remain dropped. Do not add `--no-sandbox` to make an incompatible host appear healthy.

## Published images

Versioned releases publish native amd64 and arm64 images at `ghcr.io/fulton-ring/mindful-ai`. Use a version tag from the [GitHub releases page](https://github.com/fulton-ring/mindful-ai/releases), or pin its reported image digest for repeatable deployments. `latest` points to the most recently published stable release, which can be a deliberate release on an older version line; pin a version tag or digest to control upgrades. The `sha-<full-commit>` tag identifies the source revision.

Download the matching release's `chromium-seccomp.json`, then run the published image with the same options shown above, replacing `walden:local` with `ghcr.io/fulton-ring/mindful-ai:<version>` and the seccomp path with the downloaded file. Set the provider in a private environment file, for example:

```dotenv
AUTH_MODE=none
APP_URL=http://localhost:3000
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your-own-key
AI_MODEL=your-provider-model-id
```

Each release includes checksummed corresponding-source archives for the native libraries and Debian packages in each architecture's image. These archives are companion downloads; they are not loaded at startup or stored in the runtime image. [The source instructions](../licenses/native/README.md) explain verification and reassembly. Runtime notices are retained under `/app/notices`, including the installed package versions and Chromium credits. Redistribute the notices and matching source companions with the image.

## Configuration

| Variable | Meaning |
| --- | --- |
| `APP_ROLE` | `all`, `http`, `worker`, `scheduler`, or `migrate` |
| `APP_URL` | Public origin, including scheme; must match browser access and auth URLs |
| `HOST`, `PORT` | Listener address and port; image defaults to `0.0.0.0:3000` |
| `DATA_DIR` | Persistent directory; root launcher defaults to `<repo>/.data`, image uses `/data` |
| `DATABASE_URL` | PostgreSQL connection URL; unset selects SQLite |
| `FILES_DIR` | Local object volume directory; defaults to `DATA_DIR/files` |
| `FILE_STORAGE` | `local` or `s3` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | S3-compatible service location and private bucket |
| `S3_PUBLIC_ENDPOINT` | Browser-reachable signing endpoint, when different from `S3_ENDPOINT` |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Least-privilege private object credentials |
| `S3_FORCE_PATH_STYLE` | `true` for services such as SeaweedFS; `false` for virtual-host buckets |
| `VALKEY_URL` | Shared coordination/cache URL; required for separate process roles |
| `AUTH_MODE` | `none`, `better-auth`, or `clerk` |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Stable secret and public URL for built-in authentication |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Server and browser keys from your own Clerk instance |
| `CLERK_AUTHORIZED_PARTIES` | Comma-separated browser origins allowed in Clerk session tokens |
| `AI_PROVIDER`, `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | Server-side provider connection and default chat model |
| `AI_BACKGROUND_MODEL` | Model for background work; defaults to `AI_MODEL` |
| `AI_MODELS_JSON` | Authoritative catalog: JSON array of model ID strings or metadata objects |
| `OPENROUTER_API_KEY` | Credential when `AI_PROVIDER=openrouter` |
| `EMBEDDING_MODEL_DIR` | Bundled local model path, `/app/models/minilm` in the image |
| `EMBEDDING_MODEL_REVISION` | Pinned model identity; must match the installed assets |
| `CHROMIUM_EXECUTABLE_PATH` | Optional system Chromium path; the image sets `/usr/bin/chromium`. Local development defaults to Playwright's downloaded browser. |
| `APP_POLICY_JSON` | Optional partial JSON policy for message/upload limits, retention and features |
| `MESSAGE_LIMIT`, `MESSAGE_WINDOW_HOURS` | Legacy defaults: 20 weighted points per 4 hours; `MESSAGE_LIMIT=unlimited` removes the quota |

Supply secret values through a private environment file or your orchestrator's secret mechanism. `AI_PROVIDER=openai-compatible` accepts a local or remote OpenAI-compatible service. From Docker Desktop, a host inference server is normally reachable at `http://host.docker.internal:<port>/v1`; native Linux requires an explicit host-gateway mapping or routable service address. Configure the model name your server actually provides. Startup reports available capabilities through `/api/config`; a missing provider does not create a working chat backend.

Model choices are discovered from the configured provider’s `/models` endpoint and cached. If that endpoint is unavailable, the configured default and background IDs remain available. Set `AI_MODELS_JSON` to provide an authoritative catalog, including for local services without `/models`. Both `AI_MODEL` and `AI_BACKGROUND_MODEL` must appear in that list. A simple list is valid:

```dotenv
AI_PROVIDER=openai-compatible
AI_BASE_URL=http://host.docker.internal:11434/v1
AI_MODEL=local-main
AI_BACKGROUND_MODEL=local-small
AI_MODELS_JSON='["local-main","local-small"]'
```

For labels, message-point weights and capability metadata, entries may be objects or strings:

```dotenv
AI_MODELS_JSON='[{"id":"local-main","name":"Local main","weight":1,"inputModalities":["text"],"outputModalities":["text"],"supportsTools":true,"supportsStructuredOutput":true},"local-small"]'
```

Set capability fields to match the actual endpoint; catalog metadata does not add support to a model. Weights are integers from 1 to 3. For OpenRouter, use `AI_PROVIDER=openrouter` and `OPENROUTER_API_KEY`; `AI_MODEL`, `AI_BACKGROUND_MODEL` and an optional authoritative catalog work the same way.

## Limits, retention and features

Self-hosting requires no billing service or plan setup. Leave all policy settings unset to keep the defaults: 20 weighted message points per four-hour window, five attachments per message, 1,000,000 bytes per file, and conversation expiry after seven idle days. Available tools remain enabled when their underlying providers are configured.

To change those defaults, add one optional setting to your private environment file:

```dotenv
APP_POLICY_JSON='{"messages":{"limit":null},"uploads":{"maxBytes":null,"maxFiles":null},"retention":{"idleDays":null}}'
```

`null` removes that quota or disables automatic conversation expiry. Omitted fields retain their defaults. For example:

```dotenv
APP_POLICY_JSON='{"messages":{"limit":100,"windowHours":24},"uploads":{"maxBytes":10000000,"maxFiles":10},"retention":{"idleDays":30},"features":{"mcp":false,"webResearch":false}}'
```

The full policy has `messages.limit` and `messages.windowHours`; `uploads.maxBytes` and `uploads.maxFiles`; `retention.idleDays`; and boolean `features.mcp`, `features.documentExtraction`, `features.webResearch`, `features.webSearch`. Zero message points or upload limits disable new sends or uploads. Window hours and idle days must be positive; use `null` for indefinite retention. JSON settings override the legacy message settings. Malformed configuration prevents startup/admission rather than granting unrestricted access. Restart all app roles with the same environment after changes.

Limits apply on the server as well as in the browser. Message counts survive plan changes. Upload count is per message; previously accepted files remain readable after a lower size limit is configured. Unlimited uploads still depend on available memory, disk and any upstream request limits. Document extraction and inline image processing retain a separate 32 MB input safety bound; larger accepted files remain downloadable, but cannot be processed inline. Custom document extractors can advertise their own `maxInputBytes` capability. Parser expansion, output, timeout and concurrency protections also remain in force.

Retention changes apply to active conversations using their last user activity, including before scheduled cleanup. A shorter policy can make old conversations immediately eligible for cleanup. Disabling expiry keeps active transcripts accessible; it cannot recover already purged content. Explicit archive/delete still works. The migration adds retention and cleanup-claim fields without rebuilding the conversations table or deleting related data. Cleanup claims prevent renewal while external state is being deleted; a failed cleanup can be retried after its 15-minute lease expires.

`GET /api/account/policy` returns the authenticated account's effective policy. `/api/config` reports runtime capabilities; enabling a feature in policy does not supply missing provider credentials. MCP discovery also respects the existing allowlist and read-only tool restrictions. This change adds no writable MCP tools or user-managed MCP connections.

Hosted installations may optionally define `APP_PLANS_JSON`, `APP_DEFAULT_PLAN` and `APP_ACCOUNT_PLANS_JSON`. See [account plans and future Clerk billing](adapters.md#account-plans-and-future-clerk-billing). Self-hosters can ignore all three.

## Authentication and administration

Built-in authentication uses email/password accounts with server-side sessions. Configure `AUTH_MODE=better-auth`, a stable random `BETTER_AUTH_SECRET` of at least 32 characters, and `BETTER_AUTH_URL` matching `APP_URL`. Account administration uses the image CLI with the same database and environment as the server; commands arrive as JSON over stdin so passwords do not appear in process arguments.

```sh
# First create a private JSON file with restrictive permissions:
# {"command":"bootstrap","email":"owner@example.com","name":"Owner","password":"a-long-random-password"}
chmod 600 bootstrap.private.json
cat bootstrap.private.json | docker compose exec -T app node dist/node/cli.js auth
```

Use `create-account` with the same email/name/password fields to add an account, or `reset-password` with `authUserId` and `password`. There is no automatic account merging by matching email. To retain an existing unauthenticated default account, first use `create-account` to create an unbound authentication user, then use `claim-default` with the explicit `ownerId` and `authUserId`. An auth-mode transition requires an explicit `accept-mode` command with the target `mode`. The `bootstrap` command creates a separate application account, so use the `create-account` sequence when claiming existing data. Record those IDs and review ownership before executing a transition.

```json
{"command":"claim-default","ownerId":"existing-owner-id","authUserId":"local-auth-user-id"}
{"command":"accept-mode","mode":"better-auth"}
```

For Clerk, set `AUTH_MODE=clerk`, `CLERK_SECRET_KEY`, and `CLERK_PUBLISHABLE_KEY` using keys from your own Clerk instance. Set `CLERK_AUTHORIZED_PARTIES` to the browser origin in `APP_URL` (comma-separated for multiple allowed origins), and configure that origin in Clerk. The server exposes only the publishable key to the browser and retains a stable subject-to-owner mapping. Never reuse inference or provisioning credentials for account administration.

## PostgreSQL, Valkey and SeaweedFS example

The `postgres` profile contains disposable local service examples and separate runtime roles. Stop the standalone service before using the same public port:

```sh
docker compose stop app
docker compose --env-file .env.self-hosted --profile postgres up --build -d http worker scheduler
curl --fail http://localhost:3000/health/ready
# Additional workers share PostgreSQL and Valkey:
docker compose --env-file .env.self-hosted --profile postgres up -d --scale worker=2 http worker scheduler
```

The explicitly targeted services start their shared storage dependencies; they do not start the standalone `app` service. PostgreSQL, Valkey and SeaweedFS have separate named volumes. SeaweedFS uses the official [4.48 image](https://github.com/seaweedfs/seaweedfs/releases/tag/4.48), pinned by digest. Its [single-process `mini` mode](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini) creates the `walden` bucket and seeds S3 credentials from `SEAWEEDFS_ACCESS_KEY_ID` and `SEAWEEDFS_SECRET_ACCESS_KEY`; anonymous object access is denied. WebDAV and the admin UI are disabled, and only the S3 port is published. PostgreSQL, Valkey and the bucket must become healthy before HTTP/workers/scheduler start. Each runtime process then applies pending migrations automatically before accepting work; no migration service or manual command is required. Only short-lived, owner-scoped staging upload URLs leave the application. The public signing endpoint defaults to `http://localhost:8333`, exposed on loopback; `SEAWEEDFS_PORT` changes that local port. Set `S3_PUBLIC_ENDPOINT` for another browser-reachable endpoint. CORS permits the origin in `APP_URL`. Local sample credentials are for this loopback example; replace them when configuring another environment.

The SeaweedFS example is a single-node storage service; preserve its entire `seaweedfs-data` volume. Use an independently managed replicated SeaweedFS deployment when storage availability requires multiple nodes. The application continues to use its ordinary S3 configuration in either case. [The disposable S3 contract check](../deploy/tests/storage/README.md) exercises the shipped adapter against SeaweedFS, including presigned uploads and anonymous-access denial.

For a standalone container using an existing PostgreSQL database, set `DATABASE_URL` in `.env.self-hosted`, then:

```sh
docker compose --env-file .env.self-hosted -f compose.external-postgres.yaml config
# After reviewing the resolved service configuration:
docker compose --env-file .env.self-hosted -f compose.external-postgres.yaml up --build -d
```

The external example provisions no database. It runs `APP_ROLE=all`, persists local files in `walden-postgres-files`, and requires neither Valkey nor S3. Back up PostgreSQL together with this volume, including local files and `execution-cache.sqlite` when Valkey is absent. To switch that standalone runtime to S3, set `FILE_STORAGE=s3` and the S3 variables in the private environment file. Separate HTTP/worker/scheduler roles require PostgreSQL, Valkey and S3 as shown by the `postgres` profile.

When using S3, create a private bucket beforehand and configure CORS to allow `PUT` and `Content-Type` from exactly `APP_URL`; browsers upload to staging objects through two-minute signed URLs. The application validates type, signatures and the 1 MB limit before promotion into the owner's thread. A thread accepts at most five distinct attachment references. PDF/DOCX/XLSX extraction is bounded by worker memory, a 30-second timeout, archive expansion and output limits; scanned PDFs require OCR before upload.

## Kubernetes

Use [the Helm chart](../deploy/helm/walden/README.md) for external PostgreSQL, Valkey and S3. Kubernetes uses the separate `deploy/docker/chromium-oci-seccomp.json` profile; the Docker profile contains runtime-specific conditionals and must not be used as a Kubernetes `Localhost` profile. It creates at least two HTTP replicas, two workers, one scheduler, probes and disruption budgets. Every process migrates the shared database at startup under a PostgreSQL migration lock; there is no separate migration Job. It does not create infrastructure or publish images. Review your values and rendered manifests before an explicitly authorized deployment. All runtime roles must use the same auth/model settings and shared services.

Your ingress must pass streaming responses without buffering and allow a 15-minute response lifetime. There is no sticky-session requirement for replay: readers attach by turn and sequence. Application listeners and execution start only after migrations and initialization finish. Startup fails on invalid migration history; readiness checks the initialized schema and required dependencies. SIGTERM stops admission and drains for up to 30 seconds; examples allow 60 seconds before forced termination. Durable recovery uses persisted checkpoints and shared coordination after process loss.

## Backups, restore and upgrades

Keep database and object backups from the same stopped checkpoint. A database-only backup omits attachment bytes and saved-source content. In SQLite mode, the main application database, `mastra.sqlite` and `execution-cache.sqlite` must be captured together; preserve the entire stopped data volume. A standalone PostgreSQL instance without Valkey also retains `execution-cache.sqlite` in its local data volume. Protect exports and backups as private account data.

For standalone SQLite:

```sh
# Create a database snapshot while the container is running:
docker compose exec app node dist/node/cli.js backup /data/backup.sqlite
# Stop every process before copying a matched database/object checkpoint:
docker compose stop app
mkdir -p backups
chmod 700 backups
docker compose cp app:/data backups/checkpoint
```

The copied directory contains the live database/WAL and local objects from a stopped checkpoint; retain the CLI snapshot as a separate checked database copy. Restore a checkpoint into a new empty volume, with the application stopped, then start the same image version and verify `/health/ready` before upgrading. The CLI `restore <snapshot.sqlite>` restores to an absent SQLite database path and refuses to overwrite an existing database; restore matching local objects separately. `check` runs database integrity checks. `export <file.json>` and `import <file.json>` transfer portable application data only when all turns are settled: finish or cancel active turns first. Logical transfer omits native Mastra checkpoints and refuses streaming turns before mutation. Use a physical database backup for complete durable execution and Mastra state.

For PostgreSQL, stop admission and workers for a consistent database/object checkpoint, use `pg_dump` and `pg_restore` with your managed service's backup procedures, and retain a matching private bucket snapshot/version checkpoint. Valkey is coordination/cache state; PostgreSQL remains authoritative. Do not restore different replicas to different checkpoints.

Before an upgrade, make and validate a backup, build/pull the intended image, and restart the application processes with that release. All Node roles apply pending migrations automatically before traffic or execution, including concurrent distributed replicas. The optional `migrate` role or CLI command can apply them ahead of startup, but is not required. Migrations are versioned, checksummed and transactional where supported. Retain the prior image and database backup; a binary rollback alone does not undo schema changes.

## Local development

```sh
pnpm install
pnpm dev
```

The default development launcher reads the root `.env`, prepares the checksum-verified MiniLM model and matching Playwright Chromium, and starts Vite at http://localhost:3000 with the standalone API on loopback port 3001. It applies SQLite migrations automatically and keeps local state in `.data/`, matching the root production launcher. The first run downloads the assets; later runs reuse them. Frontend edits use Vite hot reload, while API edits rebuild and restart the Node process.

No Cloudflare account is needed. With no auth configuration, this is the shared default account; set `AUTH_MODE=none` explicitly if the root `.env` already contains Clerk keys and you intend to use that shared account. Configure inference in `.env` to enable chat. Credentials remain server-side. Set `DATA_DIR` for separate development state, `PORT` for the public listener, and optionally `WALDEN_API_PORT` for the internal listener; its default is `PORT + 1`. Keep `APP_URL` equal to the public browser origin. Linux hosts may need Chromium system dependencies installed once with `pnpm --filter @walden/api exec playwright install --with-deps chromium`.

`pnpm dev:cloudflare` explicitly selects the previous Vite 5173 / Wrangler 8787 workflow, with its local D1 database and Cloudflare binding/auth requirements. See [development setup](../README.md#development) for that adapter.

[The adapter guide](adapters.md) explains how the shared application is composed for Node and Cloudflare. `pnpm test:dev` checks the development configuration. `pnpm test:dev:smoke` uses temporary state and spare ports to check native startup, the frontend/API proxy, note persistence across an API hot reload, and process shutdown; it temporarily appends and restores a retained comment in `server.ts` to trigger the rebuild.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm build:self-hosted
pnpm --filter @walden/api exec playwright install --with-deps chromium
node apps/api/scripts/download-embedding-model.mjs .cache/models/minilm
pnpm start:self-hosted
```

Run these commands beside the root `package.json`. The root launcher loads `.env`, serves the built UI/API, and keeps SQLite databases and private files in `.data/`. This directory and `.cache/` are ignored by Git and excluded from image builds. Set `DATA_DIR` to override the location; relative paths resolve from the repository root with this launcher. Credentials in `.env` remain server-side. A local OpenRouter setup needs `AI_PROVIDER=openrouter` and `OPENROUTER_API_KEY`; set `AUTH_MODE=none` explicitly when using the shared default account alongside preconfigured Clerk keys. Preserve the whole `.data/` directory when moving or backing up local state.

`pnpm test:providers` runs the same browser and API scenarios against actual Node/SQLite/local-file and workerd/D1/R2/Durable Object hosts, with controlled inference responses. Set `WALDEN_TEST_S3_ENDPOINT` to include the mixed SQLite/S3 case. [The provider matrix guide](../tests/provider-matrix/README.md) covers disposable SeaweedFS configuration and the separate opt-in browser checks against live Cloudflare and OpenRouter inference. CI runs all three deterministic provider combinations and the standalone development smoke; live credentials are not needed for those gates.

The manual/release `Self-hosted image` CI workflow runs the full application/provider checks, builds native amd64 and arm64 images, and exercises non-root sandboxed Chromium rendering, Markdown, links, screenshots and redirect restrictions. It also checks first-start readiness, UI assets, API behavior and retained attribution. Publication requires an explicit version and publish selection, or a published GitHub release. Matching source companions are uploaded before an architecture image is pushed; version and stable `latest` manifests wait for both architectures. A dispatch without publication builds and verifies the same artifacts without pushing images. It does not deploy infrastructure.

A complete operator smoke test additionally signs in when enabled, starts a note/chat, reconnects to its event stream, restarts a worker during an active turn, exercises Stop and retry, uploads/extracts a document, reads a public page, searches saved sources, and validates backup/restore against a disposable instance.
