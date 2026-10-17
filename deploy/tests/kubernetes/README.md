# Disposable Kubernetes acceptance

These tests use only the `kind-walden-selfhost-test` context and a separate
`KUBECONFIG`. Never point them at a shared cluster. The crash test deliberately
force-deletes every worker pod in the `walden-validation` namespace.

Build `walden:local` from `Dockerfile` and `walden-minio:local`
from `deploy/docker/minio.Dockerfile` using the repository root as context.
Install kind, Helm, kubectl, Python 3, and Docker first.

```sh
export KUBECONFIG="$(mktemp -d)/kubeconfig"
kind create cluster --name walden-selfhost-test --kubeconfig "$KUBECONFIG"
kind load docker-image walden:local walden-minio:local --name walden-selfhost-test
docker exec walden-selfhost-test-control-plane mkdir -p /var/lib/kubelet/seccomp/profiles
docker cp deploy/docker/chromium-oci-seccomp.json walden-selfhost-test-control-plane:/var/lib/kubelet/seccomp/profiles/walden-chromium.json
```

Create isolated PostgreSQL 17, Valkey 8, and MinIO services named
`walden-postgres`, `walden-valkey`, and `walden-minio` in `walden-validation`.
Create the private `walden` bucket. Generate disposable credentials; put database,
Valkey, and S3 credentials in the chart's `externalSecretName`. Do not use real
provider keys. Mount `fixture-provider.cjs` in a Node container as `/fixture/server.cjs`,
run `node /fixture/server.cjs`, and expose it as `walden-fixture:8080`.

Install `deploy/helm/walden` with two HTTP replicas, two worker replicas, one
scheduler, and these configuration values:

```yaml
image: {repository: walden, tag: local, pullPolicy: Never}
externalSecretName: <private fixture secret>
http: {replicas: 2}
worker: {replicas: 2}
config:
  APP_URL: http://localhost:18080
  AUTH_MODE: none
  FILE_STORAGE: s3
  S3_ENDPOINT: http://walden-minio:9000
  S3_PUBLIC_ENDPOINT: http://localhost:19000
  S3_BUCKET: walden
  S3_REGION: us-east-1
  S3_FORCE_PATH_STYLE: 'true'
  AI_PROVIDER: openai-compatible
  AI_BASE_URL: http://walden-fixture:8080/v1
  AI_MODEL: fixture-model
  AI_MODELS_JSON: '["fixture-model"]'
```

Every Helm command must include `--kubeconfig "$KUBECONFIG" --kube-context
kind-walden-selfhost-test --namespace walden-validation`. Forward **different HTTP
pods** to ports 18082 and 18083, the fixture provider to 18081, and MinIO to 19000.
Run:

```sh
python3 deploy/tests/kubernetes/acceptance.py
```

The test checks default-account agreement, cross-replica notes, completed stream
replay, a real presigned S3 upload and cross-replica download, cancellation from
the other HTTP replica, and worker-crash recovery with monotonic replay cursors
and one assistant message. It also records the migration ledger. It writes
`kubernetes-acceptance-results.json`; `WALDEN_TEST_RESULTS` can change this path.
The `WALDEN_TEST_HTTP_A`, `WALDEN_TEST_HTTP_B`, `WALDEN_TEST_PROVIDER`,
`WALDEN_TEST_ORIGIN`, and `WALDEN_TEST_NAMESPACE` variables can change the forwarded
addresses and namespace. The context remains fixed to the disposable cluster.

Re-run Helm upgrade with an innocuous config change to exercise the pre-upgrade
migration hook and rolling deployments. Confirm the saved note and migration
ledger remain unchanged. Probe Chromium with `chromiumSandbox: true` inside the
worker; never add `--no-sandbox` or host capabilities to make the probe pass.

Clean up only this cluster:

```sh
kind delete cluster --name walden-selfhost-test --kubeconfig "$KUBECONFIG"
```
