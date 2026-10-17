# Mastra execution portability spike

**Decision: continue evaluating native Mastra execution, but do not replace the current chat engine or upgrade the application yet.** The candidate passes the isolated execution checks; a broader compatibility run found an application integration issue that must be fixed separately.

Work is isolated on `spike/mastra-portability`, based on `9f2bcc1`. No existing application source, root/workspace dependency lockfile, configuration, schema, credentials, or deployment changed. All new application-side files live under `apps/api/spikes/mastra-portability`.

## Measured results — October 17, 2026

| Check | Application core 1.67.0 | Candidate core 1.78.0 |
| --- | --- | --- |
| SQLite execution acceptance suite, including Valkey cross-process tests | 10 pass, 12 fail | 22 pass, 0 fail |
| Postgres execution acceptance suite, including Valkey cross-process tests | Not tested | 22 pass, 0 fail |
| Existing stream conversion, research tools/sources, learning-check stop, length limit, valid PNG | 7 pass | 7 pass |
| Full API suite with candidate core substituted | Baseline passes | 415 pass, 2 fail, 12 skipped |

Current application verification (`pnpm verify`) passes: 41 domain, 417 API (including the seven spike checks), and 324 web tests; 12 credential-dependent tests are skipped. Typechecks and dry-run builds pass. `pnpm lint` and whitespace checks pass. The pre-spike baseline passed 775 tests; the seven new checks bring the total to 782.

See [captured results](results/) for test names and counts. These are deterministic provider tests, not live inference, authenticated browser E2E, load tests, a built application Docker image, or a deployed Kubernetes cluster. Tests ran on Node 25.2.1 and pnpm 10.30.0, with disposable local Valkey 8 and Postgres 17 containers. SQLite uses Mastra's file-backed libSQL store.

### What the execution tests actually prove

Both wrappers (`DurableAgent` and `EventedAgent`) are tested in separate child processes. We wait for the relevant event before sending SIGKILL and await the owner's exit before reopening its storage.

- Cancelling an observer's reader detaches that reader; a later observer replays the prefix and follows the same run without a second model call.
- Stop aborts a model call, preserves partial text, and ends the stream. A cooperative tool waiting before its write also stops without writing later.
- The candidate discovers and recovers a crashed model call, and does not rerun a completed tool.
- A tool interrupted **after its external write but before returning** runs again. Without an idempotency key it writes twice; with a stable logical-operation key the external effect remains single. Passing this test does not mean Mastra guarantees exactly-once external effects.
- A separate process can replay and follow events, send Stop, and observe termination over Valkey. Retained events survive the owner's SIGKILL. The candidate's recovered stream does not duplicate the cached partial answer in the tested replay flow.
- The candidate rejects ordinary recovery while another owner is healthy. The pinned version accepts that recovery request, which fails the ownership acceptance check.
- A default in-memory replay cache is empty after process restart even when workflow snapshots persist.

For fast crash tests the candidate uses `recover(runId, { force: true })` only after the old process is confirmed dead. A separate test waited 31 seconds and successfully recovered the durable wrapper without forcing takeover, confirming the ordinary lease-expiry path. Healthy-owner tests never force takeover.

The pinned version's eight crash-completion checks fail with `Cannot read properties of undefined (reading 'messages')`; the two cached-recovery checks also fail to produce the expected answer. Two healthy-owner recovery checks fail because recovery is accepted. These are deliberately failing acceptance tests, retained as reproducers rather than patched or skipped.

### Candidate compatibility findings

1. **Workspace listing breaks.** Mastra 1.78.0's list-files implementation loads `.gitignore`. Our `R2WorkspaceFilesystem.readFile()` rejects that probe with a generic `Invalid attachment path`, so the existing listing/search test fails. A future upgrade must implement correct missing-file behavior for these probes while preserving attachment path validation and owner/thread isolation. Do not widen file access to silence the error.
2. **One image fixture is invalid.** An existing test labels `[1, 2, 3]` as PNG bytes. The candidate converts it to `[Attachment unavailable: image/png]`, so its old expectation fails. A new valid one-pixel PNG passes with both versions. This is a fixture compatibility change, not evidence that valid PNGs are lost.

The opt-in candidate configuration replaces core resolution in the API test process only. Other application dependencies keep their installed versions, so this is an early upgrade compatibility screen, not validation of an upgraded dependency lockfile.

## Reproduce

From this worktree's root:

```sh
pnpm install --frozen-lockfile
pnpm --dir spikes/mastra-portability install --ignore-workspace --frozen-lockfile
```

The spike's dependencies and both version profiles have separate locks. The application lockfile is untouched. `pnpm --dir spikes/mastra-portability test` tests core 1.67.0 and intentionally exits nonzero on the recorded acceptance failures. Without `SPIKE_REDIS_URL`, distributed checks are explicitly skipped.

Start only disposable dependencies, on random localhost ports:

```sh
docker run -d --rm --name walden-mastra-spike-valkey -p 127.0.0.1::6379 valkey/valkey:8-alpine
docker run -d --rm --name walden-mastra-spike-postgres -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=walden-spike-only postgres:17-alpine
docker port walden-mastra-spike-valkey 6379
docker port walden-mastra-spike-postgres 5432
```

Wait for `docker exec walden-mastra-spike-postgres pg_isready -U postgres` to succeed. Substitute the printed ports below. All database state is disposable; do not point this harness at an application database. It initializes Mastra tables in a fresh schema per test and leaves those schemas until the container is removed.

```sh
SPIKE_REDIS_URL=redis://127.0.0.1:<valkey-port> pnpm --dir spikes/mastra-portability test
SPIKE_REDIS_URL=redis://127.0.0.1:<valkey-port> pnpm --dir spikes/mastra-portability run test:candidate
SPIKE_DATABASE_URL=postgres://postgres:walden-spike-only@127.0.0.1:<postgres-port>/postgres SPIKE_REDIS_URL=redis://127.0.0.1:<valkey-port> pnpm --dir spikes/mastra-portability run test:candidate
```

The candidate runner creates a separate temporary installation using the candidate lock; it prints the directory and leaves it available for inspection and the opt-in API checks. It never upgrades the app or the pinned spike installation. To exercise natural lease expiry instead of forced takeover:

```sh
SPIKE_RECOVERY_WAIT_MS=31000 pnpm --dir spikes/mastra-portability run test:candidate -- --test-name-pattern='durable: SIGKILL'
```

Run compatibility checks with the installed application core, or substitute the candidate directory printed by the runner:

```sh
pnpm --filter @walden/api exec vitest run spikes/mastra-portability/compatibility.test.ts
SPIKE_CANDIDATE_ROOT=<candidate-directory> pnpm --filter @walden/api exec vitest run --config spikes/mastra-portability/candidate.config.mts
pnpm verify
pnpm lint
git diff --check
docker stop walden-mastra-spike-valkey walden-mastra-spike-postgres
```

## Adoption gates

Use Mastra's existing execution machinery rather than implementing a new distributed workflow engine, provided the following are addressed in separate reviewed changes:

- Upgrade core and its compatible storage packages with the workspace issue fixed and the invalid image fixture corrected. Run the full normal checks against that actual lockfile.
- Enable running checkpoints explicitly. The harness sets `recovery.durableAgents: 'auto'`; manual Node/Hono hosting must also wire startup recovery and shutdown/draining. This spike calls `recover()` explicitly and does not validate automatic server boot recovery.
- Give standalone deployments persistent stream replay. SQLite workflow storage alone does not persist the default stream cache. Evaluate a small SQLite-backed Mastra cache or a compatible persisted application event transport; it remains unimplemented here. Distributed deployments can use the tested Postgres/Valkey combination.
- Preserve application admission, owner/branch checks, rate accounting, deletion/expiry guards, cancellation intent, and final-commit fencing. A library's cooperative abort is not a substitute for those database guards.
- Reconstruct the correct per-turn tools, owner/thread context, note state, processors, proposal collectors, and memory on recovery. Walden currently creates request-local agents and closures; registering one generic durable agent is insufficient. Recovery tests here use synthetic tools, not the live note-write path or observational memory adapters.
- Preserve Walden's event cursor protocol and partial-answer replacement behavior in the actual browser, including clients already attached when recovery starts. The harness does not exercise the existing HTTP/SSE or React reconnect implementation.
- Configure retention and cleanup explicitly. The spike disables automatic cleanup for observation; it does not validate the current one-hour replay retention, seven-day conversation expiry, or long-running resource bounds.

No production adoption, deployment, data migration, or removal of the Durable Object path is part of this spike.
