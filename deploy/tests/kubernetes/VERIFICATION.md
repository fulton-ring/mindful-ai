# Kubernetes verification — 2026-10-17

This historical run used MinIO. Current fixture instructions use SeaweedFS;
[its S3 adapter compatibility was verified separately](../storage/README.md).
The complete Kubernetes acceptance below has not been rerun with SeaweedFS.
The migration Job described in this historical run has since been removed;
current Node roles apply application migrations during startup under database locks.

Disposable local cluster: kind v0.33.0, Kubernetes v1.37.0, containerd 2.3.4,
Linux ARM64. Docker Desktop provided 8 CPUs and 8 GiB. All commands used a private
kubeconfig and `kind-walden-selfhost-test`; the user's current context and existing
containers were untouched. Provider requests used the included deterministic
fixture, without external inference calls.

Verified infrastructure:

- PostgreSQL 17.11, Valkey 8.1.10, and MinIO built from the pinned upstream source
  started successfully. AWS SDK bucket creation and HeadBucket succeeded.
- Helm resources passed Kubernetes server validation. The pre-install migration
  job initialized all four PostgreSQL application migrations on a fresh database.
- Actual containerd permissions confirmed that the corrected OCI seccomp profile
  has no capabilities and does not allow `bpf`, `mount`, `perf_event_open`, or
  `syslog`. Its intended private namespace `chroot` rule remains available.

The tests exposed two defects before acceptance. The original Docker seccomp
profile's capability conditions were ignored by containerd, so Kubernetes now
uses a separate pure OCI profile. Fresh concurrent Mastra initialization raced
while adding primary keys and indexes, causing real HTTP/worker restarts; native
initialization now uses a dedicated PostgreSQL session with nonblocking advisory
lock acquisition, outside a SQL transaction. A separate five-factory PostgreSQL
regression test covers pristine concurrent initialization.

Application acceptance is recorded below after the patched image rollout.

Patched image `walden:local` (local image digest
`sha256:28cacd008e3dbce74415493af9c9905bae92f1a8b0382439c13433ddc7a3a496`):

- A fresh native schema initialized with two HTTP replicas, two worker replicas,
  and one scheduler. All five pods became Ready within 13 seconds with zero
  restarts; no advisory locks remained after initialization.
- Both HTTP replicas used the same default account. A note created through one
  replica was visible through the other.
- A fixture turn completed and replayed 10 ordered events through the other HTTP
  replica.
- Actual S3 presigning, browser-facing upload, completion, and download through
  the other HTTP replica preserved the DOCX fixture byte-for-byte (SHA-256
  `f599f06c2bd5875d6802252e138032328fd69bd61ad5f8fccbc833e4f6cab9e2`).
- Cancellation through the other HTTP replica settled the held turn and ended
  its event stream.
- Both worker pods were force-deleted while a turn was streaming. Replacement
  workers recovered it; reconnecting after cursor 6 replayed 11 strictly
  increasing events, ended normally, and left exactly one assistant message.
- Chromium 156.0.8078.4 launched inside the worker with `chromiumSandbox: true`,
  UID 1000, no added capabilities, and rendered the expected DOM.
- The bundled local MiniLM model ran offline with native CPU ONNX and returned
  one finite 384-dimensional vector. The compiled document-worker entry parsed
  the DOCX fixture inside the pod (16 markdown characters), also as UID 1000.

The reusable `acceptance.py` completed all seven checks successfully. The native
probes ran separately after worker recovery to avoid targeting pods intentionally
killed by the crash test.

A subsequent Helm upgrade (revision 3) re-ran the pre-upgrade migration hook and
rolled all five application pods successfully. Both replacement HTTP pods read
the saved note, all four migration ledger entries were unchanged, and replacement
pods had zero restarts. All eight acceptance/upgrade assertions passed.

The disposable `walden-selfhost-test` cluster was deleted after evidence capture.
No application images were pushed and no production deployment was performed.
