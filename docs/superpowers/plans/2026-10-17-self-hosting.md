# Self-hosting implementation

Approved design: one shared application runtime hosted on Cloudflare Worker/Durable Objects or Node; standalone SQLite/local files, external Postgres, and split Kubernetes with Postgres/S3/Valkey. Instance-owned inference keys, dynamic models, optional default-user/Clerk/Better Auth, operator-created local accounts, Cloudflare-free documents and research. Preserve data and existing behavior; never deploy as part of implementation.

## Ownership and integration

All changes are on `feat/self-hosting`, now checked out in the main project directory. Both temporary worktrees were removed after preserving their commits; the `main` branch remains unchanged. Parallel implementers have exclusive file scopes; coordinator owns public contracts, environment types, manifests/lockfiles, runtime composition, UI integration and release safeguards. Review and integrate each workstream before broad verification.

- [x] Compatibility gate: actual Mastra 1.78 lockfile, workerd native execution, DO workflow fencing/cache, missing-file probe fix, valid image fixture.
- [x] SQLite/D1 normalized persistence, additive migrations, recovery descriptors/UI events, auth and research state, backup/restore.
- [x] Postgres explicit dialect queries, migrations, concurrency/locking and parity.
- [x] Shared native agent/recovery/finalization, asynchronous durable-before-send replay, generation fencing, replacement events, boot recovery/drain and retention.
- [x] Optional authentication, stable identity, Better Auth, operator administration and explicit auth-mode transitions.
- [x] Inference provider resolution, capability-aware dynamic catalogs, server model validation and background routing.
- [x] Portable local/R2/S3 storage, bounded PDF/DOCX/XLSX extraction and scoped read-only workspace.
- [x] Portable browser, private saved-source hybrid retrieval, bundled embeddings and durable indexing jobs.
- [x] Frontend auth/bootstrap/catalog/capabilities/replay integration.
- [x] Node host and roles, single OCI image, SQLite/Postgres examples, Kubernetes and migration jobs, probes and operational docs.
- [x] Existing and new feature tests, actual container/cluster/failure/restore tests; separate credential-dependent sign-off from deterministic checks.
- [x] Independent specification and code-quality reviews; no unresolved release blockers silently counted as passing.

## Required invariants

No destructive schema resets. Admission, accounting, branch overlap, cancellation and final commits remain atomic. Native workflow ownership does not replace application guards. UI sequence is monotonic across recovered generations; disconnected readers do not cancel inference. Preserve absolute 15-minute turn budget, one-hour replay, seven-day conversation expiry, private owner-scoped data and explicit note decisions. Uncertain external effects are not blindly repeated. No secrets in browser configuration or durable snapshots. Missing auth settings on a new instance use one persistent default account; a protected populated database cannot silently become public.

Production workflows must be manually invoked, not triggered by ordinary main pushes. Production rollout is outside this implementation authorization.

## Verification evidence

- Final `pnpm verify`: all seven typecheck tasks, 967 tests (577 API, 349 web, 41 domain), and all five build tasks passed. The API suite explicitly skips 48 gated external/native checks; separate integration runs below exercise the local native services. Lint, the compiled Node build and `pnpm db:check` also passed.
- Actual emitted Cloudflare Worker runs in workerd, including application bootstrap, native durable execution/replay/recovery, and repeated purge. Node integration covers completion, Stop, graceful restart, forced process loss, generation fencing, ownership races, privacy cleanup, and offline embedding retrieval. Real PostgreSQL, Valkey, SQLite and S3 integration gates passed; five concurrent pristine PostgreSQL native hosts initialize without leaked advisory locks.
- Actual Linux ARM64 image checks passed for nonroot sandboxed Chromium, offline CPU embeddings, compiled PDF/DOCX/XLSX extraction, health/UI/configuration, persistent default identity and notes, direct uploads, private CLI export, backup and restore. The final image includes the concurrent PostgreSQL initialization fix.
- Disposable Kubernetes acceptance and upgrade evidence is recorded in [the Kubernetes verification report](../../../deploy/tests/kubernetes/VERIFICATION.md), with a reusable deterministic provider and acceptance harness.
- Actual Chrome and HTTP API acceptance against local OpenRouter inference passed 25 checks, covering chat, note context/autosave/history, persona selection, reload/replay, Stop, DOCX extraction, rendered-page reading, saved-source search, source attribution, mobile layout/drafts, search, exports and API fences. The run exposed and fixed recovery of an admitted user absent from committed branch history, plus stale asynchronous history responses. Independent review and 14 focused backend/frontend tests confirmed the final canonical-user fix. Disposable test threads and their note were removed; the original conversation's hash stayed unchanged.
- Native startup now uses the root `pnpm start:self-hosted` launcher and ignored `.data/` directory. The actual data move/restart preserved the original conversation and uploaded bytes, with SQLite integrity `ok`; 25 focused native runtime/config/storage tests passed. Docker's actual build context excluded `.data` and private environment files. The refreshed ARM64 image passed a fresh-account health/config/UI smoke.
- SeaweedFS replaces MinIO in deployment examples. [The actual S3 contract and restart check](../../../deploy/tests/storage/README.md) passed; the earlier Kubernetes report retains its historical MinIO evidence accurately.
- Independent specification and quality reviews are clear, including the PostgreSQL startup-lock and canonical-user recovery fixes. Native AMD64 image validation is configured in the image workflow but was not run locally. Clerk/Better Auth browser login flows, remote CI, publishing, and production rollout were not exercised. Chrome's file picker automation required extension file-URL permission, so upload bytes were verified through HTTP and attachment rendering/extraction through the browser.

## Adapter and development follow-up

- Root `pnpm dev` now selects native standalone development with root `.env`, `.data/`, Vite on port 3000 and the watched Node API on 3001. `pnpm dev:cloudflare` retains the explicit Workers development workflow. Ten focused launcher/proxy tests and an actual spare-port startup, source rebuild, persistence and shutdown smoke passed. The managed local app was switched to `pnpm dev`; OpenRouter remains configured and the original conversation exactly matches the pre-switch snapshot.
- Typed Node adapter factories support replacing object storage, extraction, browsing and saved-source indexing independently. Readiness, startup failure and shutdown use the selected provider; unused local model/parser assets are not required by replacement providers. Six actual runtime adapter tests and the existing native storage/runtime suites passed; independent review found no material issues. See [the adapter guide](../../adapters.md).
- The actual browser/API matrix passed **18/18** scenarios: Node/SQLite/local files, workerd/D1/R2/Durable Objects, and Node/SQLite/SeaweedFS. Coverage includes browser file selection and signed S3 uploads, exact bytes, note CRUD/revision/export, chat, Stop, active reload recovery without duplicate user/provider calls, monotonic replay and terminal replay after actual host restart. Fixtures use temporary state and ports. The matrix exposed and verified a fix for D1 cascaded note deletion being incorrectly reported as 404.
- The separate live browser gate passed **2/2**: Cloudflare inference with actual D1/R2/DO and OpenRouter inference with native SQLite/local files. Each completed a browser chat and preserved one user and assistant across reload. Live Cloudflare rendered Markdown, links and screenshot probes also passed; remote AI Search was not exercised because there is no dedicated disposable test index.
- Final `pnpm verify` passed **978 tests** (584 API, 353 web, 41 domain), seven typechecks and five builds. Forty-eight gated API cases remain explicitly skipped in that command. A separate native run passed **102 tests** with real PostgreSQL, Valkey, SQLite, sandboxed Chromium, parser workers, offline embeddings and forced process loss. Repository lint passed. CI now runs the three provider combinations and dev smoke; remote CI has not been run from this session.
