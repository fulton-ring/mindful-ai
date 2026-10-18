# Disposable SeaweedFS S3 contract

This runs only the SeaweedFS service from the shipped Compose configuration in
its own project and named volume. It does not start or stop the application,
PostgreSQL, Valkey, or existing storage services. Install workspace dependencies
with `pnpm install --frozen-lockfile` first; the test uses the installed AWS SDK
and esbuild to load the actual `S3ObjectStore` implementation.

```sh
SEAWEEDFS_PORT=18333 docker compose --env-file /dev/null -p walden-seaweed-contract --profile postgres up -d --wait seaweedfs
WALDEN_TEST_S3_PREFIX=contract/seaweed-4.48/ node deploy/tests/storage/seaweed-contract.mjs
SEAWEEDFS_PORT=18333 docker compose --env-file /dev/null -p walden-seaweed-contract --profile postgres restart seaweedfs
WALDEN_TEST_S3_PREFIX=contract/seaweed-4.48/ node deploy/tests/storage/seaweed-contract.mjs --verify-persistence
# Removes only this disposable project's data:
SEAWEEDFS_PORT=18333 docker compose --env-file /dev/null -p walden-seaweed-contract --profile postgres down --volumes
```

The script waits for authenticated bucket readiness. It asserts that a two-minute
presigned PUT accepts a nonempty body, the adapter reads the same bytes, anonymous
bucket listing/object reads/writes and incorrect credentials are denied, and CORS
allows only the configured app origin. It also checks Unicode metadata,
conditional writes, pagination, batch deletion, and persisted bytes after restart.
`WALDEN_TEST_S3_ENDPOINT` can select another disposable loopback port. The matching
`SEAWEEDFS_ACCESS_KEY_ID` and `SEAWEEDFS_SECRET_ACCESS_KEY` environment variables
can override the sample fixture credentials in both Compose and the test.

Verified on 2026-10-17 with Docker Desktop Linux ARM64 and the official
`chrislusf/seaweedfs:4.48` multi-platform image digest
`sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`.
All contract and named-volume restart assertions passed. This is a distinct
storage compatibility check; the historical Kubernetes acceptance report used
MinIO and is not evidence of a SeaweedFS Kubernetes deployment.

Upstream references: [4.48 release](https://github.com/seaweedfs/seaweedfs/releases/tag/4.48),
[`weed mini` quick start](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini),
and [S3 authentication](https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API).
