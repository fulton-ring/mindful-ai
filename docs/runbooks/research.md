# Web research

The main Mastra agent uses direct tools, with no separate research-agent framework.

## Configuration

- `OPENROUTER_API_KEY` enables `searchWeb`. The tool uses Gemma through OpenRouter's managed Exa search, independently of the main chat provider. Production chat remains on Workers AI.
- `BROWSER`, `AI_SEARCH`, and `AI_SEARCH_INSTANCE` enable page reading and the saved-source index. Local development can use the existing Cloudflare application token and account ID for REST transport.
- `pnpm dev` runs standalone development at port 3000 with the native API on 3001, root `.env`, SQLite and the local saved-source index. `pnpm dev:cloudflare` selects Vite 5173 / Wrangler 8787 with local D1; that mode reads root `.env` and `apps/api/.dev.vars`.
- Deployment credentials remain separate from the application's Cloudflare token. Do not load the root `.env` into Wrangler deployment commands.

## Dedicated Cloudflare verification

The `walden-e2e` instance in the default namespace uses built-in storage and text metadata
fields `owner_scope` and `source_url`. Its cache is disabled so indexing and deletion checks
observe current results. The existing application token has the required AI Search Edit and
Run access. Private `apps/api/.env.live` selects this instance through `AI_SEARCH_INSTANCE`.

```sh
pnpm --filter @walden/api test:search:live
```

The opt-in test uploads a synthetic page under a unique owner scope, waits for indexed
retrieval, verifies another scope cannot retrieve it, deletes that scope's content and waits
for deletion to become visible in search. The instance remains available for future runs.
Ordinary tests skip these remote operations. Cloudflare limits item listing to 50 per page;
cleanup collects all matching pages before deleting to avoid skipping entries.

Verified on 2026-10-18 against the actual service, including indexed retrieval, owner
isolation and eventual deletion. A failed cleanup revealed the old 100-item page size;
the adapter now uses 50, with a regression covering 51 files across two pages. Existing
`mindful-ai-sources` content and standalone `.data` were not used by this check.

## Tool behavior

`searchWeb` searches the public web and returns provider-supplied citation URLs and excerpts, not the search model's generated explanation. Each turn permits two calls, each bounded to one provider search, five sources, 2,000 characters per source, a 25-second timeout, and a bounded response body. Search incurs OpenRouter model and search usage.

`readWebPage` reads a public URL supplied by a user or returned by a search. Exact URLs are checked before fetching, so the model cannot invent an exfiltration URL or append private note data to a permitted URL. The browser is restricted to the requested origin. Local addresses, IP literals, credential-bearing URLs, and non-HTTP protocols are rejected. This is a basic boundary, not a guarantee against every DNS or upstream browser vulnerability.

`searchSources` searches only previously retrieved, owner-scoped public pages. It is not general web search. Retrieved public pages may outlive the conversation. Notes and chats are not uploaded to this index.

All sources are treated as untrusted data. Core instructions require current-event lookup, grounded citations, and explicit uncertainty. A failed web lookup terminates the answer with a retryable error rather than letting the model claim that no reports exist. Placeholder URLs are not evidence. Source reading remains useful if indexing fails; the UI distinguishes those states.

## Verification — September 20, 2026

- Chrome reproduced and then verified the Hugging Face/OpenAI search regression: successful web-search activity, a cited answer, and five sources.
- A Worker-only failure was found: `redirect: "error"` is unsupported. Fetch now uses `manual` and rejects non-success responses.
- Unit/integration checks cover failed lookup termination, source normalization, cancellation, response bounds, per-turn limits, credential-like query rejection, and appended-data URL rejection.
- Safety instructions cover harmful assistance, self-harm support, high-stakes uncertainty, prompt injection, and private-data handling. Chrome verified refusal of a request for cookie-stealing code while ordinary incident analysis remained available.
- These are basic guardrails, not a comprehensive safety certification or a separate moderation service. Query filtering catches recognizable identifiers and credentials; it cannot identify every form of private information. Main-model prompt injection and harmful-content behavior still need ongoing adversarial evaluation.

References: [OpenRouter web search](https://openrouter.ai/docs/guides/features/server-tools/web-search), [Cloudflare page indexing](https://developers.cloudflare.com/ai-search/how-to/fetch-and-index-web-pages/).
