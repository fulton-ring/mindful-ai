# Replacing providers

Application routes and chat tools consume service contracts. Host startup creates the adapters and owns their readiness and shutdown. Choose providers independently: using Cloudflare inference does not require D1 or R2, and using R2 does not require Cloudflare inference.

| Dependency | Contract / selection point | Implementations |
| --- | --- | --- |
| Private objects | `storage/object-store.ts`: `ObjectStore` | Local filesystem, S3 compatible services (including SeaweedFS and R2), native R2 binding |
| Application database | `db/database.ts`: `AppDatabase` | SQLite, PostgreSQL, native D1 binding |
| Document extraction | `storage/document-extractor.ts`: `DocumentExtractor` | Bounded local parser workers, Workers AI |
| Web browsing | `services/research/ports.ts`: `ResearchBrowser` | Playwright, Cloudflare Browser Rendering |
| Saved sources | `services/research/ports.ts`: `SavedSources` | Local hybrid retrieval over SQLite/PostgreSQL and object storage, Cloudflare AI Search |
| Model inference | `services/agent/agent.ts`: `createConfiguredModel` | Workers AI, OpenRouter, OpenAI compatible endpoints |
| Authentication | `auth.ts` and `auth/state.ts`: explicit auth mode | Default account, Clerk, Better Auth |
| Durable execution | `execution/native-agent.ts`: `NativeExecutionHost` | Mastra storage/cache backed by Durable Objects/D1, SQLite, or PostgreSQL/Valkey |

Paths in this table are relative to `apps/api/src`. Existing Cloudflare bindings remain supported. Provider-specific defaults and compatibility fallbacks live at their selection points; adding an object store does not require editing chat routes, attachment handling, or research indexing.

## Add an object store

1. Add an adapter, for example `apps/api/src/storage/custom.ts`, implementing `ObjectStore`. Keep SDK clients and credentials inside that adapter.
2. Wire its factory into the Node composition root using `createNodeRuntime(config, { adapters: { createObjectStore } })`. The default runtime still selects local storage or S3 from configuration.
3. Exercise the real adapter's bytes, metadata, missing objects, conditional writes, listing/cursors, deletion, and upload behavior. Then run the browser/API provider matrix against the resulting host.

For example, a custom entry point can construct the existing S3 adapter with a different endpoint without changing application services:

```ts
import { readNodeConfig } from './platform/node/config';
import { createNodeRuntime } from './platform/node/runtime';
import { createS3ObjectStore } from './storage/s3';

const config = readNodeConfig();
const runtime = await createNodeRuntime(config, {
  adapters: {
    createObjectStore: () => createS3ObjectStore({
      endpoint: process.env.CUSTOM_STORAGE_ENDPOINT,
      region: 'us-east-1',
      bucket: 'private-objects',
      forcePathStyle: true,
      // The SDK's normal credential chain supplies server-side credentials.
    }),
  },
});
// Pass runtime.fetch to the HTTP listener. On shutdown, await runtime.close().
```

For SeaweedFS or another S3 compatible service, the documented `FILE_STORAGE=s3` and `S3_*` settings already provide this wiring; no new adapter is necessary.

An adapter supporting signed uploads implements `presignPut` and advertises `uploadMode: 'presigned'`. An adapter receiving uploads through the authenticated API advertises `uploadMode: 'direct'`. Conditional `put` must return `null` when its precondition fails. Do not silently emulate atomic conditional writes with an unprotected read followed by a write.

The Node composition root also accepts `createDocumentExtractor`, `createResearchBrowser`, and `createSavedSources` factories through the typed `NodeRuntimeAdapters` contract in `platform/node/runtime-adapters.ts`. Replacing extraction or saved-source retrieval skips the bundled worker or embedding assets used only by the default implementation. Providers can expose `ready` and `close`; the runtime checks readiness and closes owned resources on startup failure or shutdown. A saved-source provider can expose `resume(signal)` for durable indexing work. Its `deleteOwner` must remove only the requested owner's data, whichever provider created it.

## Keep real differences explicit

Database adapters must preserve transactions, admission and cancellation fences, constraints, and dialect-specific queries. Adding another SQL dialect also requires migrations and concurrency tests. Authentication providers need session verification, stable owner mapping, account deletion, and browser integration. Execution providers must preserve durable replay and recovery semantics. Those changes involve more than implementing CRUD methods in a single file.

Split-role and replica configuration still requires PostgreSQL, Valkey and S3. A custom storage factory does not bypass those deployment checks; supporting a new shared-storage selection also requires updating the startup configuration validation.

Use the existing contracts and ordinary imports. Adapter factories provide the extension point; a runtime plugin loader or dependency injection framework is unnecessary.
