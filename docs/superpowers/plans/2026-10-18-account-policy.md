# Account policy and billing extension implementation plan

> **For agentic workers:** Use subagent-driven-development with disjoint ownership and independent specification/correctness review. The user approved the policy/entitlements design and implementation; no payment integration is requested.

**Goal:** Make self-hosted quotas, conversation retention and features configurable, and let a future hosted billing adapter select the same application-owned account plans on Node or Cloudflare.

**Architecture:** Shared typed policy, validated operator defaults and plan overrides; an optional server-owned entitlement provider returns a configured plan ID for a stable app account. Request admission, uploads, tool construction, retention and the account UI consume the effective policy. Preserve default behavior and atomic accounting; do not implement checkout or payment-provider webhooks.

**Tech stack:** Existing TypeScript, Zod, Hono, React, SQLite/D1/PostgreSQL and Vitest/Playwright. No new billing dependency.

## Shared contract and configuration

`AccountPolicy` contains `planId` and `policy`: `messages {limit:number|null,windowHours:number}`, `uploads {maxBytes:number|null,maxFiles:number|null}`, `retention {idleDays:number|null}`, and `features {mcp:boolean,documentExtraction:boolean,webResearch:boolean,webSearch:boolean}`. Null means unlimited/no expiry. Defaults remain 20 points/4h, 1,000,000 bytes/5 files, 7 idle days and existing configured feature availability.

`APP_POLICY_JSON` supplies a validated partial default policy, `APP_PLANS_JSON` maps plan IDs to partial policies, `APP_DEFAULT_PLAN` selects the default (`default`), and `APP_ACCOUNT_PLANS_JSON` optionally maps internal owner IDs to operator-selected plans. Existing MESSAGE_LIMIT/MESSAGE_WINDOW_HOURS remain supported (explicit `unlimited` for the limit); explicit JSON overrides legacy defaults. Unknown plans and malformed configuration fail closed. Operator assignments take precedence over an optional `env.ENTITLEMENTS.getPlan(ownerId)` provider, then the configured default. A provider supplies a plan ID, never arbitrary browser-provided policy.

Authenticated `GET /api/account/policy` exposes only that account's effective plan/policy; public config continues to describe physical capabilities. Shared exports live in contracts, with server resolver under `apps/api/src/policy/`.

## Workstreams

- [x] Root: contracts, policy configuration/provider/resolver, authenticated endpoint, plan/default documentation and integration coordination.
- [x] Usage: nullable message budgets with explicit unlimited behavior, existing atomic admission/refund semantics, metrics and quota tests. Server routes resolve account policy for each admission.
- [x] Retention: adjustable/no-expiry policy across creation, extension, request guards, purge and runtime scheduling. Existing conversations adopt changed policy without restoring already purged content. Avoid destructive parent-table rebuilds on D1/SQLite; migration changes must preserve all related rows. Agent proposes exact safe representation and integration seam before edits.
- [x] Uploads: use effective size/count at initiation, streaming direct upload, completion and chat admission; propagate compatible parser input bounds. Previously accepted uploads remain readable after plan downgrade. Keep parser resource controls separate from product quotas.
- [x] Features: gate MCP discovery and document/research/web-search tools server-side by account policy while preserving configured capability checks and read-only MCP restrictions.
- [x] Web: load/invalidate account-scoped policy, use dynamic composer limits, render unlimited budget and no-expiry retention clearly; preserve old-server fallback. No billing/upgrade UI.
- [x] Verification: focused red/green regressions, typechecks, lint, complete verification, native database gates and browser/API matrix on actual Node and workerd; test unlimited/small-limit/no-expiry/provider-selected plans and default regressions.
- [x] Independent reviews and final managed local restart with original data preserved; commit all work on `feat/self-hosting`, do not deploy or modify billing accounts.

## Safeguards

Policy originates from trusted server configuration/provider adapters. No client plan selection. Upgrade/downgrade must not reset accounting or hide already accepted files. Retention opt-out must affect request checks as well as jobs; disabling only a cron is insufficient. The running app is stopped during coordinated schema changes, backed up locally, and restarted only after checks pass. Future billing adapters should project verified/idempotent provider events into local state and resolve by stable application account ID; payment state and auth identity remain separate concerns.

## Implemented safeguards

Billing remains entirely optional; Clerk membership billing connected to Stripe is the intended future hosted integration. Self-hosting uses direct policy configuration without plans or provider setup. No checkout, payment SDK or webhook handler was added.

Retention uses additive `retention_disabled`, `purge_started_at` and `purge_token` columns. Cleanup claims fence concurrent policy changes and renewal; stale claims retry after 15 minutes. Recovery and execution cleanup synchronize current retention before interpreting old deadlines. Logical imports retain compatibility with schema-v1 exports and refuse pending purges. Accepted uploads remain readable after downgrade; document and inline-image processing use separate physical buffer protections.

Final verification: `pnpm verify` passed (682 API, 370 web, 41 domain tests; optional/live gates skipped), `pnpm lint` and `pnpm --filter @walden/api db:check` passed. The managed local app was restarted with OpenRouter; the original conversation's four stored messages match the stopped backup exactly and SQLite integrity is healthy. The final native gate passed 121 tests, including real PostgreSQL/Valkey, Chromium, emitted Worker, document/embedding providers and SIGKILL recovery. The final browser/API matrix passed 24 cases across Node/local files, Cloudflare/D1/R2/DO and Node/SeaweedFS; three mixed-storage policy cases are intentionally skipped because policy parity is covered on both runtimes. `pnpm test:dev` also passed. Independent policy, upload and retention reviews found no remaining concrete issues after the fixes.
