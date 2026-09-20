# Browser Run and AI Search

The app uses direct Mastra tools. No Code Mode, QuickJS, sandbox, or Worker Loader is installed or enabled.

## Local startup

The normal `dev` command remains usable without research credentials. To enable research locally, provide `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, and `AI_SEARCH_INSTANCE=mindful-ai-sources` through the existing local environment-loading path, then run:

```sh
pnpm --filter @walden/api dev:research
```

Stop the existing API process on port 8787 before starting `dev:research`; leave the web process on 8788 running. The command continues to use local workerd (`--local`) and does not deploy the application. When both REST credentials are present, the service calls Browser Run and AI Search through their authenticated Cloudflare REST endpoints. Wrangler login and remote-binding proxy authentication are not required for this path. Do not print the credential values.

The private `mindful-ai-sources` instance is in the `default` namespace. It has built-in storage, a disabled public endpoint, and text metadata fields `owner_scope` and `source_url`. The REST transport scopes upload and search URLs to that namespace and instance. The `research` Wrangler environment also declares native `BROWSER` and `AI_SEARCH` bindings as a deployment-compatible fallback when REST credentials are absent. Browser quick actions require a modern compatibility date; the config uses 2026-09-18.

## Behavior

- `readWebPage({url})` reads rendered Markdown and queues it for indexing. It returns content immediately after upload acknowledgement, without waiting for embedding/index completion. If indexing fails, the successfully read content remains usable and the tool reports the indexing failure.
- `searchSources({query})` searches pages already indexed for the signed-in user. It is not general web search. The server supplies the owner filter; the model cannot choose another owner.
- Retrieved pages retain source URLs for citations. Page content and queries do not enter PostHog payloads. Chats and notes are not uploaded to the search index.
- Indexed public pages persist independently of thread expiry/deletion and can be reused across that user's threads. Source-library management is not yet exposed in the UI.
- Browser requests are restricted to the requested origin. Sites requiring cross-origin assets or redirects may fail or render incompletely. There is no authenticated browsing, cookies, form submission, or arbitrary script tool.
- A main turn allows up to five steps, one tool call at a time, within the existing 75-second deadline. Tool outputs and timeouts are bounded; Mastra's existing context processors still apply.

## Verification

Focused tests cover URL restrictions, REST endpoint and instance scoping, multipart upload metadata, owner separation, output limits, cancellation, safe indexing failure, and multi-step Mastra tool execution with citations/status events. API typecheck and the research-profile Worker dry run passed.

Chrome verified a real page read, compact tool activity, source disclosure, Markdown citation, and persistence after reload. A fresh-thread native search call completed but returned no results. Direct API investigation found the application token can search (200) but item upload/list return 403; the instance contains no indexed items. Earlier assistant prose claiming a queued acknowledgement was not reliable evidence and is superseded by these direct checks. After the user updated permissions and propagation completed, direct checks with the application token uploaded a synthetic document and retrieved its text with an owner-scoped query (both 200). The synthetic document was then removed. Chrome subsequently verified read→index→search on a fresh branch: readWebPage produced a cited answer, then searchSources retrieved the page and produced a cited answer with compact activity and a source disclosure.

Index upload failure now returns a safe reason (`permission_denied` or `indexing_unavailable`) while preserving readable page content. The tool summary exposes “Source read · not saved to search.” Agent instructions prohibit describing failed uploads as queued or previous assistant prose as a current tool result. Uploads require AI Search Edit for the same account; search alone can work without item-write access.

A real Gemma run through Mastra also passed: it called both research tools against synthetic bindings and returned a supported answer with a source link. That test is opt-in (`RUN_LIVE_RESEARCH=1`) and does not substitute for a real local binding check.

References: [fetch and index pages](https://developers.cloudflare.com/ai-search/how-to/fetch-and-index-web-pages/), [Browser Run](https://developers.cloudflare.com/browser-run/), [AI Search retrieval](https://developers.cloudflare.com/ai-search/api/search/workers-binding/).

## Local transport compatibility

Live testing found two remote-preview problems: the Browser binding proxy did not implement `quickAction`, and Cloudflare edge preview failed with code `10023` because the account feature was unavailable. The local profile therefore stays on `--local`. When account ID and application token are present, **both** page reading and AI Search upload/search use REST, avoiding the preview proxy entirely. Requests use `redirect: manual`, forward cancellation, validate Cloudflare response envelopes, and reject non-2xx responses. Without complete REST credentials, the same tools use the native bindings when those bindings are available, which is the deployment fallback.
