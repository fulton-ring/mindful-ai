# Browser and API provider matrix

Run from the repository root with Node 24.15+ and installed workspace dependencies:

```sh
pnpm exec playwright install chromium
node apps/api/scripts/download-embedding-model.mjs .cache/models/minilm
pnpm test:providers
```

The runner builds the web app, native Node entry, and production Wrangler worker before testing.
Use `--skip-build` after those artifacts have already been built. Set `EMBEDDING_MODEL_DIR` to
reuse an installed model; inference and the tests never download model weights.

The same six scenarios run against:

| Project | Application runtime | App database | Private files | Native turn persistence |
| --- | --- | --- | --- | --- |
| `node` | Emitted Node server | Real file SQLite | Local files | File libSQL and persistent cache |
| `cloudflare` | Exact emitted Worker in workerd/Miniflare | Real local D1 | Real local R2 | SQLite Durable Object workflows and cache |
| `mixed` | Emitted Node server | Real file SQLite | Actual S3-compatible endpoint | File libSQL and persistent cache |

Cloudflare serves the built frontend through a small same-origin static host that forwards every
API request to the emitted Worker. Application routes, authentication middleware, execution,
database queries, file operations, and streaming are not mocked. The inference fixture is a real
HTTP OpenAI-compatible server with deterministic complete/held SSE responses, following the
deployment fixture protocol in `deploy/tests/kubernetes/fixture-provider.cjs`.

Coverage includes note create/save/revision/export/delete; exact attachment byte upload and
download; chat commit; strictly increasing event cursors and terminal replay; Stop with partial
output; browser file upload, note creation and editing; browser reload/resume without duplicate
user messages or inference calls; and completed replay after a real application host restart.
Browser reload tests keep inference active across detachment; host restart tests cover terminal
durability. These tests do not claim abrupt in-flight process-crash coverage.

Both default projects use ephemeral loopback ports and isolated temporary state, removed when
the worker fixture closes. They do not load `.env`, `.data`, or an existing app server. Browser
contexts decline conversation sharing through the first-use privacy dialog. Playwright retains
failure traces, screenshots, application logs, and inference counts under
`test-results/provider-matrix`; the HTML report is under `playwright-report/provider-matrix`.

To include mixed S3, provision a disposable SeaweedFS/S3 service and bucket, then run:

```sh
WALDEN_TEST_S3_ENDPOINT=http://127.0.0.1:18334 node tests/provider-matrix/run.mjs --skip-build
```

Defaults are bucket `walden`, access key `walden-local`, and secret `walden-local-password`.
Override these using `WALDEN_TEST_S3_BUCKET`, `WALDEN_TEST_S3_ACCESS_KEY_ID`, and
`WALDEN_TEST_S3_SECRET_ACCESS_KEY`. The endpoint must be browser-reachable and permit browser
PUTs from the ephemeral test origins through CORS. Use a disposable bucket: its objects live
until the external service is removed. The harness starts/stops only its own app processes and
does not stop the S3 service. CI provisions and removes its own SeaweedFS instance.

Select projects with `WALDEN_MATRIX_STACKS=node,cloudflare,mixed`, or pass normal Playwright
arguments such as `--project cloudflare` or `--grep 'API Stop'` to the runner.

The deterministic matrix does not exercise remote Cloudflare Workers AI, Browser Rendering,
AI Search, OpenRouter, or any other paid service. The separate live browser gate tests chat
and reload persistence against Workers AI on D1/R2/Durable Objects and OpenRouter on native
SQLite/local files. It supplies credentials only to the server. Configure
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `OPENROUTER_API_KEY` in a private,
ignored `.env.providers` file, then run:

```sh
node --env-file=.env.providers \
  node_modules/@playwright/test/cli.js test --config tests/provider-matrix/live.config.ts
```

`pnpm test:providers:live` runs the same gate when credentials are already in the environment.
Cases without their provider credentials are explicitly skipped. The live gate has its own
tests and output directory; fixture call-count and held-response
assertions apply only to the reproducible matrix. Live model inference does not establish
coverage for remote browser/search services.
