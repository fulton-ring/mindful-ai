# Mastra portability spike

**Goal:** Measure native Mastra execution without changing Walden's production code, dependency lockfile, configuration, schema, credentials, or deployment.

**Architecture:** An independent package under `spikes/mastra-portability` pins the application's Mastra version. A deterministic AI SDK model and a tool with a durable side-effect ledger exercise real Mastra agents, file-backed libSQL, and an isolated local Valkey instance. Child processes provide actual crash, restart, and remote cancellation boundaries. Findings distinguish supported behavior from missing guarantees; the spike must not patch Mastra to make checks pass.

**Execution:** Complete inline in the `spike/mastra-portability` worktree. No deployment, production migration, dependency upgrade, or application execution-path change is authorized by this spike.

- [x] Record the baseline `pnpm verify` result at commit `9f2bcc1` (775 tests pass).
- [x] Create an independent, pinned package and assert replay/detach and Stop behavior for durable and evented wrappers with a deterministic model.
- [x] Exercise actual SIGKILL/reopen with file-backed storage; record snapshot discovery, recovery completion, repeated model/tool calls, and loss or retention of partial stream events.
- [x] Exercise observer and Stop from a separate process with distributed PubSub and a persistent replay cache. The pinned version accepts recovery of a healthy owner's run; the candidate rejects it. Also test Postgres and ordinary lease expiry in the candidate.
- [x] Compare native output with Walden's existing stream conversion, including tool progress, source sanitization, structured learning-check events, and interrupted/length-limited output. Identify request-local callback/state that recovery would need to reconstruct.
- [x] Run the spike assertions, existing verification, focused compatibility checks, lint, and whitespace checks. Pinned acceptance: 10 pass/12 fail; candidate: 22/22 pass on SQLite and Postgres. Current app: 782 pass. Candidate API screen: two recorded compatibility failures; no application fixes made.
- [x] Write a results matrix, reproduction commands, limitations, and a migration go/no-go recommendation in the spike README. Leave application adoption for a separate reviewed change.

**Result:** Native execution is a viable direction with the isolated 1.78.0 candidate. Adoption remains gated by the workspace missing-file contract, an image-fixture update, persistent standalone stream replay, and integration checks for application ownership, per-turn state, retention, and the real browser transport. See `spikes/mastra-portability/README.md`.
