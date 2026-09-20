# Web research

The main Mastra agent uses direct tools, with no separate research-agent framework.

## Configuration

- `OPENROUTER_API_KEY` enables `searchWeb`. The tool uses Gemma through OpenRouter's managed Exa search, independently of the main chat provider. Production chat remains on Workers AI.
- `BROWSER`, `AI_SEARCH`, and `AI_SEARCH_INSTANCE` enable page reading and the saved-source index. Local development can use the existing Cloudflare application token and account ID for REST transport.
- Run `pnpm dev`. Web runs on 5173; the API runs on 8787 with local D1 storage. Local config reads the root `.env` and `apps/api/.dev.vars`.
- Deployment credentials remain separate from the application's Cloudflare token. Do not load the root `.env` into Wrangler deployment commands.

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
