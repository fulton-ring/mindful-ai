# Walden Helm chart

Deploy Walden, an open-source [Fulton Ring](https://fultonring.com) product, on Kubernetes.

This chart runs two HTTP replicas, two worker replicas and one scheduler. Each process applies pending application migrations before serving traffic or starting execution. PostgreSQL migration locks serialize concurrent startup; no separate migration Job is required. PostgreSQL, Valkey and a private S3 bucket are external dependencies. The chart creates no cloud resources or credentials.

Build and publish the image through your own registry process, then set `image.repository` and `image.tag`. Provision an existing Kubernetes Secret whose keys are runtime environment variables: `DATABASE_URL`, `VALKEY_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `BETTER_AUTH_SECRET`, and the credentials for your inference provider. Keep endpoints and bucket names in `config` values. The browser must be able to reach `S3_PUBLIC_ENDPOINT` when that differs from the internal S3 endpoint.

Chromium runs with its sandbox enabled as uid 1000. Install [the provided seccomp profile](../../docker/chromium-oci-seccomp.json) on each eligible node at `/var/lib/kubelet/seccomp/profiles/walden-chromium.json`, accounting for a custom kubelet root. The chart selects that `Localhost` profile. This OCI profile is filtered for dropped host capabilities on Linux amd64/arm64 with a modern kernel (4.8 or newer). Do not install the Docker-specific profile in Kubernetes: containerd does not evaluate Docker’s conditional capability filters. Hosts must permit unprivileged user namespaces. If your cluster's `RuntimeDefault` profile already permits Chromium's namespace syscalls, verify a sandboxed launch first, then set `seccompProfile.type=RuntimeDefault` and `seccompProfile.localhostProfile=null`.

Example values file:

```yaml
image:
  repository: registry.example/team/walden
  tag: v0.1.0
externalSecretName: walden-runtime
config:
  APP_URL: https://walden.example
  AUTH_MODE: better-auth
  FILE_STORAGE: s3
  S3_ENDPOINT: https://s3.example
  S3_PUBLIC_ENDPOINT: https://s3.example
  S3_BUCKET: walden
  S3_REGION: us-east-1
  S3_FORCE_PATH_STYLE: 'false'
```

```sh
helm lint deploy/helm/walden -f values.production.yaml
helm template walden deploy/helm/walden -f values.production.yaml > rendered.yaml
# Review rendered.yaml and your existing services before the explicitly authorized rollout:
helm upgrade --install walden deploy/helm/walden -f values.production.yaml --wait --timeout 10m
```

Set controller-specific options through `ingress.annotations`, or provide your own ingress. Configure it to preserve streaming responses: disable response buffering, allow at least a 15-minute read timeout, and forward the original scheme and host. `/health/live` checks the process; `/health/ready` checks initialization, schema and runtime dependencies. SIGTERM drains before exit; the chart allows 60 seconds for the application's 30-second drain. Application state is in PostgreSQL/S3; `/data`, `/tmp` and Chromium shared memory are ephemeral in this chart. Back up the database and objects together before schema upgrades. See [the operator guide](../../../docs/self-hosting.md).
