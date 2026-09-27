# Presigned Workspace Files Implementation Plan

**Goal:** Upload chat attachments through presigned R2 URLs and let the agent extract, read, and search uploaded documents through its scoped Mastra workspace.

**Architecture:** The API signs short-lived PUT URLs for a private staging key. A completion endpoint validates the stored bytes, promotes them to the existing thread prefix, and returns the attachment ID. The agent receives extension-aware paths and one document extraction tool that caches Cloudflare Markdown output beside the original file; Mastra's read-only workspace tools handle navigation and search.

**Tech Stack:** Hono, R2, AWS S3 presigner, Workers AI `toMarkdown`, Mastra workspace, React, Vitest.

---

### Task 1: Upload contract

**Files:** `apps/api/src/chat/attachments/attachments.ts`, `apps/api/src/chat/attachments/presign.ts`, `apps/api/src/chat/turns/routes.ts`, `apps/web/src/lib/api.ts`, `apps/api/src/chat/attachments/tests/presign.test.ts`.

- [ ] Test that initiate signs a scoped staging PUT and completion rejects missing, oversized, invalid, or mismatched files.
- [ ] Implement the signer using the AWS SDK and short expiry; keep credentials in the Worker.
- [ ] Validate the completed R2 object and promote it to the immutable final key.
- [ ] Change the browser upload helper to initiate, PUT, and complete; retain a local-only development path when signing credentials are unavailable.

### Task 2: Workspace paths

**Files:** `apps/api/src/agent/r2-workspace.ts`, `apps/api/src/agent/context.ts`, `apps/api/src/agent/tests/r2-workspace.test.ts`.

- [ ] Test that text attachments have extension-aware virtual paths and Mastra grep finds text in them.
- [ ] Map original and derived Markdown paths to private R2 keys without using user-supplied names as keys.
- [ ] Update conversation attachment context to advertise these paths once per turn.

### Task 3: Document extraction

**Files:** `apps/api/src/agent/document-tool.ts`, `apps/api/src/services/agent/agent-stream.ts`, `apps/api/src/agent/tests/document-tool.test.ts`.

- [ ] Test that only thread attachments can be extracted and that conversion is cached after the first call.
- [ ] Call `env.AI.toMarkdown` for PDF, DOCX, and XLSX; store Markdown sidecars under the thread prefix.
- [ ] Expose one `extractDocument` agent tool that returns the sidecar workspace path.

### Task 4: Verification

- [ ] Run focused API and web tests, typechecks, lint, and build.
- [ ] Exercise the local browser upload flow and a live Cloudflare conversion with synthetic files.
- [ ] Inspect the final diff for temporary files and unrelated changes.
