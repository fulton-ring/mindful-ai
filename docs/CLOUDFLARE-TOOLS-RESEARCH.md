# Cloudflare search, browsing, and Mastra Code Mode

Current decision: Browser Run + AI Search are implemented as direct Mastra tools. The user explicitly declined Code Mode; the research below is historical, not an implementation instruction. No Code Mode dependencies or runtime bindings were added. See [research runbook](runbooks/research.md).

Research date: September 18, 2026. This note describes supported product surfaces; it does not provision resources or read credentials.

## Findings

Cloudflare Browser Run, formerly Browser Rendering, provides managed Chromium. A Worker can use a `browser` binding for stateless Quick Actions such as rendered HTML, Markdown, links, screenshots, PDFs, JSON extraction, and crawling, or it can launch a browser session through Puppeteer, Playwright, CDP, or Stagehand. Quick Actions through a binding need a Worker compatibility date of at least `2026-03-24`; this repository currently uses `2025-09-17`. Local development can use a remote browser binding, and Cloudflare documents `wrangler dev --remote` or `remote: true` for a real hosted browser. [Browser Run overview](https://developers.cloudflare.com/browser-run/get-started/) [Wrangler binding reference](https://developers.cloudflare.com/browser-run/reference/wrangler/)

Browser Run is page retrieval and automation, not a search index. Its crawl action follows pages from a supplied site, but it does not discover arbitrary web results from a query. Cloudflare AI Search is also not open-web search: it retrieves from an AI Search instance populated from configured websites, R2, or uploaded files. It has an `AI_SEARCH` Worker binding and supports `remote: true` during local development. [AI Search agent integration](https://developers.cloudflare.com/agents/tools/ai-search/) [AI Search guides](https://developers.cloudflare.com/ai-search/how-to/)

Mastra 1.67 has a browser abstraction, but its documented providers are AgentBrowser, Stagehand, FirecrawlBrowser, and BrowserViewer. It has no native Cloudflare Browser Run provider. AgentBrowser can connect to any CDP endpoint, so a Cloudflare browser session may be technically connectable, but that adds session lifecycle and provider integration work. Mastra also notes that browser screencast packages are incompatible with Cloudflare Workers. [Mastra browser documentation](https://mastra.ai/docs/browser)

For this application, the smallest browser integration is therefore a normal Mastra `createTool` around a narrow Browser Run Quick Action, initially Markdown or links for one validated public URL. This keeps Cloudflare authentication in the binding, avoids a long-lived browser, and preserves Mastra input validation, request context, tracing, and tool allow-listing. The tool must reject non-HTTP(S) URLs, credentials in URLs, private/link-local/loopback destinations, redirects to disallowed destinations, and excessive responses. Browser access should remain read-only; interactive actions, logins, form submissions, downloads, and arbitrary file URLs need a separate product and security decision.

No Cloudflare-only general web-search tool is available. If the product needs current open-web discovery, it needs a dedicated search API or an explicitly approved search-engine integration. AI Search is appropriate only for a curated knowledge base. Browser Run can then fetch selected result pages.

## Code Mode

The installed `@mastra/core@1.67.0` includes `createCodeMode` from `@mastra/core/tools`. It returns an `execute_typescript` tool and matching instructions. The model writes one async TypeScript function; only that orchestration program runs in a sandbox. Calls such as `external_search(...)` bridge back to the real Mastra tools on the host, where their schemas, request context, and tracing still apply. Each Code Mode instance captures an explicit tool allow-list. [Mastra Code Mode documentation](https://mastra.ai/docs/agents/code-mode)

Mastra's default Code Mode transport writes a program to a filesystem and invokes `node`. `LocalSandbox` is suitable for trusted local development on a host, but it cannot execute inside the Cloudflare Worker runtime. Production requires a remote sandbox plus a compatible transport.

For serverless hosts, Mastra documents `QuickJsCodeModeTransport` from `@mastra/quickjs`. It runs the orchestration program in an in-process QuickJS WebAssembly runtime with no filesystem, network, or process access; only the allow-listed `external_*` bridge is available. Current `@mastra/quickjs@0.1.1` accepts core 1.67. This is the smallest plausible Code Mode runtime for the existing Worker. It still needs a Worker bundle/dry-run check and local behavioral test before adoption; the current repository has not established that the package's WASM initialization fits its Worker startup limits. [Mastra Code Mode documentation](https://mastra.ai/docs/agents/code-mode)

Mastra also publishes `@mastra/cloudflare-sandbox`. Version `0.3.0` supports the installed core range and implements a Mastra sandbox by calling a separately deployed Cloudflare Sandbox Bridge over its `/v1/sandbox` HTTP API. Its configuration is `new CloudflareSandbox({ baseUrl, apiToken, id?, sandboxId?, workingDirectory?, commandTimeout? })`. It is not a direct Workers binding adapter. More significantly for Code Mode, the package exports no Cloudflare-specific `CodeModeTransport`, while Mastra's default transport is documented as local-host only. The adapter therefore is not currently a drop-in Code Mode execution backend. A compatible remote transport would still be required. [Cloudflare Sandbox Bridge](https://developers.cloudflare.com/sandbox/bridge/) [Cloudflare Sandbox architecture](https://developers.cloudflare.com/sandbox/concepts/architecture/)

Cloudflare Sandbox itself uses Workers, Durable Objects, and Containers and is available on the Workers Paid plan. A direct Sandbox SDK integration requires `@cloudflare/sandbox`, a container image, a Durable Object binding and migration, and container configuration. Local execution builds the container with Docker; it is materially heavier than the current `wrangler dev` loop. The Mastra bridge can be unit-tested with a fake HTTP transport, but a meaningful end-to-end test requires a locally running or deployed bridge/container. [Sandbox SDK setup](https://developers.cloudflare.com/sandbox/get-started/) [Sandbox SDK overview](https://developers.cloudflare.com/sandbox/)

The configured `@cf/google/gemma-4-26b-a4b-it` model has native function calling, coding ability, and a 256K context window, so it has the advertised capabilities needed to invoke `execute_typescript` and write orchestration code. This is capability evidence, not proof of reliable Code Mode behavior. Before enabling it for users, run a model-specific evaluation covering valid tool composition, malformed programs, timeouts, refusal to call unavailable tools, result-size limits, and prompt injection in retrieved pages. [Gemma 4 on Workers AI](https://developers.cloudflare.com/changelog/post/2026-04-04-gemma-4-26b-a4b-workers-ai/)

Cloudflare also publishes an experimental `@cloudflare/codemode` package. Its browser entry point runs generated JavaScript in a client-side iframe against browser-owned tools; it does not control a remote browser. That is a different orchestration stack from Mastra Code Mode and does not remove the server-side sandbox requirement for the existing agent. [Cloudflare Code Mode](https://developers.cloudflare.com/agents/tools/codemode/) [Browser integration](https://developers.cloudflare.com/agents/tools/codemode/browser/)

## Recommended minimal architecture

1. Add one read-only Mastra tool backed by a Cloudflare Browser Run binding for rendered Markdown from an explicitly validated public URL. Update the compatibility date and configure the binding only when implementing the tool. Use a remote binding for local integration tests; mock the binding for unit tests.
2. If curated retrieval is needed, add AI Search separately and treat its instance as an indexed knowledge base. Do not label it web search.
3. Implement the bounded QuickJS compatibility spike below, then enable Mastra Code Mode for read-only retrieval if it passes. Code Mode is useful here as the browser, curated search, and file tools emerge because it can fetch several sources concurrently and return only a compact synthesis input.
4. Use `@mastra/quickjs` first because it supplies the documented serverless transport without a container or external credentials. Restrict its allow-list to read-only tools and enforce short execution/output limits. Use the Cloudflare Sandbox Bridge only after Mastra supplies a compatible transport or the application deliberately implements and owns one.
5. Do not put note mutation, account operations, unrestricted HTTP fetch, browser interaction, or filesystem writes inside the Code Mode allow-list. Note changes should continue through the existing proposal and explicit acceptance path.

This order gives the agent useful source reading with one Cloudflare binding and no code-execution infrastructure. It also leaves a supported path to Mastra Code Mode if multi-tool orchestration later earns its operational cost.

## Local compatibility spike and exact integration plan

The published `@mastra/quickjs@0.1.1` package is a close version match: its peer range is `@mastra/core >=1.55.0 <2`, while this application uses 1.67. It depends on `quickjs-emscripten` and `ts-blank-space`; it has no native binary, postinstall step, Node flag, external service, secret, or Worker binding. Its transport declares `requiresSandbox = false`. The generated program starts with no filesystem, network, process, timer, or module APIs. Tool arguments and results cross the WebAssembly boundary as JSON, and the host enforces the tool allow-list. The implementation supports concurrent host calls without asyncifying the WebAssembly module, and applies an interpreter heap limit, stack limit, execution timeout, and abort signal.

The material unknown is bundling and startup inside this specific Worker. The package calls `getQuickJS()` from `quickjs-emscripten`, which resolves its release WebAssembly module at runtime. Although Mastra documents this transport for serverless environments, the package metadata still declares Node `>=20.19.0`; that engine declaration is not evidence of workerd compatibility. Wrangler must prove that it bundles the WebAssembly asset correctly and that initialization stays within Worker startup limits.

Use this staged test after installing only `@mastra/quickjs@0.1.1` in the API workspace:

1. Add a unit test that constructs `QuickJsCodeModeTransport({ memoryLimitMb: 32 })` and calls `transport.run()` directly with a fixed program that invokes two allow-listed host functions concurrently, combines their JSON results, and returns a small value. Assert the two dispatches, returned value, blocked unknown tool, timeout, and abort behavior. This executes real QuickJS WebAssembly without involving a model.
2. Run the API's normal Node Vitest suite, typecheck, and `wrangler deploy --dry-run --outdir <temporary-directory>`. Record compressed and uncompressed Worker size changes.
3. Add a temporary test-only Worker route or isolated Wrangler fixture that runs the same direct transport test under local `workerd`. This verifies WebAssembly loading in the actual runtime. It needs no Cloudflare credentials or bindings.
4. Build a minimal Mastra `createCodeMode` fixture with two read-only deterministic tools. Use `createCodeMode({ tools, timeout: 5_000 }, new QuickJsCodeModeTransport({ memoryLimitMb: 32 }))`; add its returned `instructions` to the agent instructions and register its returned tool under `execute_typescript`. Test one known program without an LLM, then make one real Gemma request that must call both tools and combine their values.
5. Evaluate Gemma over repeated cases: sequential dependency, `Promise.all`, filtering a larger result before return, unavailable tool, malformed code, tool exception, timeout, and prompt injection inside a tool result. Capture whether it invokes `execute_typescript`, emits syntactically valid code, and returns the correct result. Keep direct tools unavailable to that test agent so the evaluation measures Code Mode rather than fallback behavior.
6. If these checks pass, wire the production agent with a small read-only allow-list first: Browser Run page read, curated search, and read-only file access. Set a short timeout and 32–64 MiB QuickJS heap initially. Continue to keep note proposals and every mutation outside Code Mode.

The minimum package change for this Mastra path is:

```text
pnpm --filter @walden/api add @mastra/quickjs@0.1.1
```

It requires no new Wrangler binding. Browser Run remains separate and needs:

```jsonc
{
  "compatibility_date": "2026-03-24 or later",
  "browser": { "binding": "BROWSER" }
}
```

For local browser integration tests, configure that binding as remote or use Wrangler's documented remote development mode. The QuickJS unit and workerd tests remain local and credential-free.

### Cloudflare-native Code Mode comparison

`@cloudflare/codemode@0.5.2` offers `DynamicWorkerExecutor`, which runs each program in an isolated Dynamic Worker and blocks outbound network access by default. It needs a Worker Loader binding:

```jsonc
{
  "worker_loaders": [{ "binding": "LOADER" }]
}
```

This is a strong Cloudflare-native execution boundary, and recent Wrangler supports local Worker Loader development. Its standard AI integration, however, is `createCodeTool()` from `@cloudflare/codemode/ai`, which produces an AI SDK tool rather than a Mastra `CodeModeTransport`. The package has no adapter for Mastra's `createCodeMode`. Its AI entry point also peers on AI SDK 6 or 7 and Zod 4, while this application currently uses AI SDK 6 with Zod 3. Adopting it would require one of two compatibility projects: wrap `DynamicWorkerExecutor` in a custom Mastra transport, or replace Mastra `createCodeMode` with Cloudflare's AI SDK tool and convert the existing tools and schema stack. Neither is a minimum integration.

Prefer Mastra QuickJS for the first implementation because it preserves Mastra tool validation, request context, tracing, and generated instructions with one package and no binding. Keep Cloudflare Dynamic Workers as the fallback if the QuickJS bundle fails Worker validation or its latency is unacceptable. That fallback requires `@cloudflare/codemode`, a `LOADER: WorkerLoader` environment type, the `worker_loaders` Wrangler entry, and an explicit adapter/AI-SDK integration spike. [Cloudflare AI SDK integration](https://developers.cloudflare.com/agents/tools/codemode/ai-sdk/) [Dynamic Workers Code Mode example](https://developers.cloudflare.com/dynamic-workers/examples/codemode/)

## Actual QuickJS compatibility spike

The spike ran in an isolated `/tmp` npm project with `@mastra/core@1.67.0`, `@mastra/quickjs@0.1.1`, and the application's current Wrangler baseline, `4.38.0`. It did not install application dependencies, change application code, read credentials, provision resources, or deploy anything.

Direct execution under Node passed. A real `QuickJsCodeModeTransport({ memoryLimitMb: 32 })` program called an allow-listed mock lookup tool twice through `Promise.all`, received both JSON results, and returned the expected combined value. The dispatcher observed exactly the two permitted calls. A second program attempted to call an unexposed `external_private` function; QuickJS returned a `ReferenceError`, and the host dispatcher was never reached. This confirms that the package runs with core 1.67 and that unavailable tools are absent from the sandbox global scope.

Wrangler's dry-run bundle also completed successfully and reported no bindings:

```text
Total Upload: 12230.84 KiB / gzip: 1970.56 KiB
No bindings found.
--dry-run: exiting now.
```

That bundle check was insufficient to establish Worker compatibility. Starting the same minimal Worker with the local runtime failed before it could serve a request. The bundled `typescript/lib/typescript.js`, pulled in through the QuickJS transport's TypeScript-stripping path, evaluated code that reads Node's `__filename` global:

```text
Uncaught ReferenceError: __filename is not defined
  at isFileSystemCaseSensitive
  at getNodeSystem
  ...
  node_modules/typescript/lib/typescript.js
```

Wrangler 4.38 also warned that its local runtime supports compatibility dates only through `2025-09-17` and substituted that date for the fixture's `2026-09-18` date. The `__filename` failure is the first clear runtime blocker, so the spike stopped there as planned. No shim, bundler alias, or custom transport workaround was attempted.

The same fixture was then rerun after upgrading **only the temporary project** to Wrangler `4.135.0`. The current workerd failed with the same `ReferenceError: __filename is not defined` while evaluating `typescript/lib/typescript.js`. This rules out the old Wrangler/workerd version as the cause; no application upgrade is warranted for this issue.

The import chain is direct and unconditional at module startup:

```text
application Worker import
  -> @mastra/quickjs/dist/index.js
  -> ts-blank-space/out/index.js
  -> typescript/lib/typescript.js
  -> Node-only __filename access during module initialization
```

`@mastra/quickjs@0.1.1` imports `ts-blank-space` at its top level. `ts-blank-space@0.6.x` in turn imports the full `typescript` package at its top level; the isolated installation resolved TypeScript `5.9.3`. The failure therefore occurs before a `QuickJsCodeModeTransport` instance runs and cannot be avoided by delaying transport construction.

The practical result is that `@mastra/quickjs@0.1.1` is **not locally runnable in Cloudflare workerd as packaged**, with either the project's Wrangler 4.38 baseline or Wrangler 4.135. A dry-run bundle is false confidence here. Making it work would require owning a bundler shim/alias, changing or patching the package's TypeScript erasure dependency, or contributing an upstream fix; none is a drop-in integration, and this spike intentionally did not attempt those workarounds.

The minimum supported architecture for Code Mode on this deployment is consequently Cloudflare's `@cloudflare/codemode` with its Worker Loader binding, used as a separate AI SDK tool path rather than Mastra's `createCodeMode`. Its concrete cost is one dependency, a `worker_loaders` Wrangler binding, a corresponding `WorkerLoader` environment type, conversion of the selected read-only Mastra tools to the Cloudflare/AI SDK tool contract, and focused local tests for the new execution boundary. If preserving Mastra `createCodeMode` is mandatory, wait for a Worker-compatible upstream transport or accept ownership of a custom adapter; neither option is a few-line change.
