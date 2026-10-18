# Replacing providers

Walden is a [Fulton Ring](https://fultonring.com) product. This guide covers replacing its runtime providers.

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
| Account entitlements | `policy/index.ts`: optional `EntitlementsProvider.getPlan(ownerId)` | Local policy configuration; optional hosted plan adapter |
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

## Account plans and future Clerk billing

No billing integration is needed to run Walden. `APP_POLICY_JSON` directly configures the default account policy. Authentication and billing are separate: selecting Clerk authentication does not enable a paid plan or require billing credentials.

For the hosted version, the intended billing integration is Clerk membership billing connected to Stripe. The shared application accepts only a configured plan ID for a stable internal application account. Quotas and tool access are application policy, with no Clerk or Stripe checks scattered through routes or tools. Checkout, subscription management, webhooks and payment processing are not implemented here.

Operators can exercise plans without any billing provider:

```dotenv
APP_POLICY_JSON='{"messages":{"limit":20}}'
APP_PLANS_JSON='{"free":{"features":{"mcp":false}},"premium":{"messages":{"limit":100},"uploads":{"maxBytes":10000000,"maxFiles":10}}}'
APP_DEFAULT_PLAN=free
# Optional operator assignment using the ID returned by GET /api/account:
APP_ACCOUNT_PLANS_JSON='{"application-account-uuid":"premium"}'
```

Each plan inherits the global policy defaults, then applies its own partial overrides. The implicit `default` plan always exists. Unknown plans, assignments to unknown plans, malformed JSON and unsupported fields fail closed. The account assignment wins over the optional provider, which wins over `APP_DEFAULT_PLAN`. Plan IDs supplied by a browser are ignored.

A future adapter implements this small server-side port:

```ts
import type { EntitlementsProvider } from './policy';

const entitlements: EntitlementsProvider = {
  async getPlan(ownerId) {
    // Resolve the app UUID through trusted server-owned membership state.
    // Return a configured plan ID, or null to use the operator's default.
    return lookupConfiguredPlanForAccount(ownerId);
  },
};
```

Wire it through Node's optional `adapters.createEntitlementsProvider(config, { db })` factory, or supply `ENTITLEMENTS` in the Cloudflare composition root. The Node runtime manages its optional readiness and shutdown hooks. With no factory/binding, there is no billing adapter to initialize or call.

When integrating Clerk billing, map Clerk membership records to stable app accounts on the server. Resolve current entitlements from verified server data; if projecting billing events locally, verify signatures and handle duplicate/out-of-order events. Do not trust client plan claims, infer ownership by matching email, or return unrestricted policy on a provider failure. Cancellation/downgrade should select the configured fallback plan while preserving existing usage accounting and accepted files. Decide organization-versus-user membership ownership when implementing billing; the current app policy is keyed by its existing account UUID.

## Keep real differences explicit

Database adapters must preserve transactions, admission and cancellation fences, constraints, and dialect-specific queries. Adding another SQL dialect also requires migrations and concurrency tests. Authentication providers need session verification, stable owner mapping, account deletion, and browser integration. Execution providers must preserve durable replay and recovery semantics. Those changes involve more than implementing CRUD methods in a single file.

Split-role and replica configuration still requires PostgreSQL, Valkey and S3. A custom storage factory does not bypass those deployment checks; supporting a new shared-storage selection also requires updating the startup configuration validation.

Use the existing contracts and ordinary imports. Adapter factories provide the extension point; a runtime plugin loader or dependency injection framework is unnecessary.
