# Public source and container release implementation plan

> **For agentic workers:** Use subagent-driven-development for the independent notice tasks and review the integrated release before publishing. Preserve hosted resources, authentication, existing runtime behavior, and the local development server.

**Goal:** Deploy the verified cleanup, publish the source repository, and provide tested public container releases with retained notices and corresponding source materials.

**Architecture:** Production continues through the existing manually dispatched, verification-gated Cloudflare workflow and private production profiles. Offline, version-specific license supplements fill omissions in published npm archives. Native and browser notices stay with the image; corresponding-source archives and a checksummed index accompany releases. A separate release workflow builds and tests an image before registry publication; secrets and private configurations never enter its context.

**Tech stack:** Existing Node scripts/tests, pnpm, Docker/Buildx, GitHub Actions/GHCR and release assets, Wrangler, existing browser/API integration matrix.

## 1. Merge, deploy, and verify hosted behavior

- [x] Confirm both latest PR #3 verification jobs succeeded at `df8a1f8`; merge the reviewed commit.
- [x] Create `feat/public-container-release` from merged `origin/main`; keep implementation off `main`.
- [x] Dispatch `ci.yml` on `main`; retain the existing private configuration secrets and URL variables.
- [x] Confirm deployment jobs succeed, then verify runtime config, protected API auth, signed-in chat/reload, uploads, landing app/legal links and redirects.

Deployment run `39150561028` passed all jobs at `51da930c93a741e95acbcacd994851503754f28a`. Public config, protected API rejection, landing links/redirects and signed-in chat/reload passed. Synthetic thread: `477dd122-d9a9-46a8-8a27-2ddcb367b2f5`. After the production `walden-attachments` CORS rule added `https://chat.withwalden.app` (existing rule preserved, with explicit user approval), an authenticated hosted upload of a pasted 1×1 PNG completed and its preview rendered (`complete: true`, 1×1); the draft was cleared. The extension's file-picker permission is not an app requirement, since the supported paste path exercised actual upload and download. No user files were uploaded.

Commands: `gh run view RUN --json status,conclusion,jobs`; use the logged-in browser session for authenticated app verification. Do not manually reapply migrations or change production data beyond disposable smoke-test records.

## 2. Publish source after the final exposure check

- [x] Scan all reachable Git history with the verified Gitleaks binary using `--redact=100 --ignore-gitleaks-allow --log-opts=--all`.
- [x] Review scanner metadata against the six known false positives; confirm ignored private profiles and environment files remain untracked.
- [x] Change `fulton-ring/mindful-ai` visibility to public using GitHub's explicit visibility-change command; verify unauthenticated access.

All 116 reachable commits were scanned before the visibility change: six reviewed false positives, zero confirmed credentials. Unauthenticated GitHub API access confirms `private=false`.

## 3. Complete offline npm license texts

Files: `licenses/npm/**`, `scripts/third-party-notices.mjs`, `scripts/release-licenses.test.mjs`.

- [x] Resolve missing texts from exact upstream package versions, retaining original copyrights and URLs. Where the published declaration is the available grant, preserve it verbatim with clearly labeled canonical terms; never invent a copyright notice.
- [x] Store supplements in a manifest keyed by `package@version`, with file paths, immutable provenance and SHA-256 hashes; include Linux amd64/arm64 variants used by releases.
- [x] Write and observe failing fixture tests for a recognized supplement, version mismatch and checksum mismatch. Implement the minimal offline loader; unknown future omissions remain flagged.
- [ ] Regenerate actual web/container notices and confirm every shipped JavaScript dependency has retained license text. Native binary subcomponents have separate coverage in task 4.

Commands: `pnpm test:licenses`; `node scripts/third-party-notices.mjs OUTPUT`; inspect remaining `^MISSING_LICENSE_TEXT:` lines. Do not add runtime dependencies or weaken Mastra authorization/license checks.

## 4. Preserve native/browser/OS notices and corresponding sources

Files: `scripts/container-notices.mjs`, its focused tests, `licenses/native/**`, and the native supplement fragment under `licenses/npm/native/**`. Root integrates `Dockerfile`.

- [x] Inventory the real image's Node, Debian, Playwright Chromium/FFmpeg, Sharp/libvips, ONNX, canvas and other native distributions. Replace the proprietary Chrome for Testing/Widevine distribution with Debian Chromium and retain the existing sandbox.
- [x] Collect exact upstream license/copyright texts and preserve installed Debian notices.
- [ ] Produce a versioned, checksummed source index and corresponding-source archives needed by redistributed copyleft binaries; keep large source archives outside the runtime image as release companions.
- [ ] Test missing artifacts/checksum failures before implementing collection; verify artifacts against a real image and retain upstream build/source provenance.

No claim of complete redistribution clearance is based on package metadata or filenames alone. Bundled Mastra enterprise files are informational under the recorded upstream maintainer clarification; intentionally enabling enterprise features still requires their applicable terms.

## 5. Build, validate, and publish containers through CI

Files: `Dockerfile`, the existing `.github/workflows/self-hosted-image.yml`, `scripts/public-image-check.mjs` and focused tests, `docs/self-hosting.md`, `THIRD_PARTY_NOTICES.md`.

- [x] Extend the existing image workflow with explicit release/version input, least-privilege registry permissions and no secrets on pull-request builds. Reuse the full CI workflow with production deployment explicitly disabled.
- [ ] Build the exact image, run attribution checks and disposable health/API smoke tests before publication, and retain full app/provider matrix gates.
- [ ] Publish version and commit tags to `ghcr.io/fulton-ring/mindful-ai`, accompanied by source/notice artifacts; update `latest` only for a successful stable release.
- [x] Document anonymous single-container startup, persistent `/data`, optional OpenRouter configuration, immutable image references and source artifact locations.
- [ ] Run spec review, then code-quality review, targeted tests, lint, clean Docker build and the initialized no-mistakes gate. Commit/push on the feature branch, validate CI and merge through the PR.
- [ ] Execute the release workflow and pull/run the published image anonymously to verify the actual public artifact.

Pre-commit verification: `pnpm verify` passed (41 domain, 370 web and 700 API tests; 54 opt-in API tests skipped), `pnpm check:ci` passed, and the focused release/license/native suite passed 29 tests. Separate spec and code-quality reviews reported no blocking findings. Real Docker runtime/browser/source builds remain in progress before publication.

User-added scope: reduce deployed `node_modules`. `scripts/prune-deployment.mjs` runs after `pnpm deploy` in the `prod-dependencies` stage, removing dependency source maps, TypeScript declarations and non-target ONNX Runtime binaries without following symlinks, and fails if the target binding or ONNX Runtime is missing. Measured on the final arm64 runtime image: 522,600,782 bytes pruned, `/app/node_modules` 1051 MiB to 550 MiB, compressed image 662,818,072 to 526,528,760 bytes. The pruned image passed the attribution guard, sandboxed browser checks with network-disabled native CPU embeddings, and the standalone API notes/attachment smoke. amd64 is covered by the release matrix.

Do not publish an image whose required notices/source artifacts are incomplete. Production deployment and public source release remain independently verifiable milestones while packaging work proceeds.
