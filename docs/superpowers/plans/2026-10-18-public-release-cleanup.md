# Public release cleanup implementation plan

> **For agentic workers:** Use the executing-plans skill to implement this plan task by task. Keep the existing runtime behavior and private production resources intact.

**Goal:** Remove operator-specific defaults from the public source and make distribution licensing explicit and verifiable.

**Architecture:** Checked-in Wrangler files are portable examples. Hosted deployments use ignored copies supplied through production environment secrets, while URLs needed by the landing build come from environment variables. Generated third-party notices travel with browser assets and the container. Mastra enterprise functionality is not replaced or bypassed; public image distribution requires a separate package-content check.

**Tech stack:** Node.js scripts and tests, pnpm's installed license inventory, Wrangler, Vite/Astro, Docker, existing provider matrix.

## 1. Preserve hosted configuration, then remove production defaults

- [x] Copy the two existing Wrangler files to ignored `wrangler.production.private.jsonc` files, with private file permissions.
- [x] Store those exact files in the GitHub production environment as `WALDEN_APP_WRANGLER_CONFIG` and `WALDEN_LANDING_WRANGLER_CONFIG`; retain `CLOUDFLARE_API_TOKEN` separately.
- [x] Update deployment jobs to require the configuration secret, write it without shell interpolation, and pass the private file to Wrangler explicitly.
- [x] Make public configuration anonymous by default, remove account/Clerk/PostHog identifiers and custom routes, and use an example D1 UUID. Make landing URLs configurable with localhost defaults.
- [x] Remove personal paths, internal instance IDs, stale deployment instructions, and production identifiers from current documentation and fixtures. Do not rewrite Git history or alter live resources.
- [x] Validate hosted profiles using Wrangler dry runs and compare their resource identifiers and auth settings to the preserved copies.

## 2. Retain third-party notices in distributable artifacts

- [x] Add a Node script using `pnpm licenses list --prod --json` and installed license/notice texts to generate a deterministic notice artifact without local filesystem paths.
- [x] Exercise notice collection with small package fixtures before implementing it, including nested notices and missing-license handling.
- [x] Include the generated artifact in web and landing builds and copy it into the Docker runtime, alongside the existing project/model licenses.
- [x] Update `THIRD_PARTY_NOTICES.md` with actual artifact locations and the precise Mastra limitation.

## 3. Check public image contents without breaking private self-hosting

- [x] Add an explicit public-image check that reports enterprise modules/chunks, missing notice artifacts, and missing model license files. Use fixture tests and inspect the real built image.
- [x] Keep existing application and private Docker behavior intact. Do not downgrade Mastra, remove permission checks, or introduce an enterprise shim.
- [x] Document the pinned release's enterprise imports and the required upstream resolution before publishing images.

## 4. Verify and ship the cleanup

- [x] Run `pnpm check:ci`, script tests, `pnpm verify`, and Wrangler dry runs with the preserved private profiles.
- [x] Build the Docker image and run the affected browser/API provider matrix, including Node, Cloudflare and SeaweedFS.
- [x] Re-run the secret scan, verify private profiles are ignored, and review the diff for changes to hosted auth/resource identities.
- [ ] Commit and push on `feat/public-release-cleanup`; record CI results in the pull request. Preserve the repository's private visibility.

## Verification evidence

- `pnpm verify`: 1,108 tests passed (697 API, 370 web, 41 domain); 54 opt-in tests skipped. An initial local turn-store/worker timeout passed on the unchanged focused suite and full rerun.
- `pnpm test:licenses`: four tests passed, including nested attribution, absent license text, enterprise detection, and avoiding the MIT `ee-first` false positive.
- Provider browser/API matrix: 24 passed, three intentional mixed-policy skips, across Node, Cloudflare, and disposable SeaweedFS. Chromium required execution outside the filesystem sandbox.
- Docker build and readiness, API config, note create/edit/export/delete, and served notices passed. The explicit public-image check correctly rejected retained Mastra enterprise files and missing upstream license texts.
- Both private hosted profiles remain byte-identical to the original configurations and mode `0600`; their Wrangler dry runs passed. Production environment configuration secrets and public URL variables are installed.
- Gitleaks scanned 112 reachable commits: six previously reviewed false positives, zero confirmed credentials. Private profiles remain ignored.
- User selected preserving Mastra and gating public image publication. Repository visibility and image publication are unchanged.
- Final landing review: default, `.env`, and shell-precedence builds verified canonical URLs, links and all five redirects; the `.env` file is a tested Turbo cache input. No dependency changes were needed.
