# Note apply provider research

Research date: September 18, 2026. This is a design note only; it adds no provider, dependency, secret, or runtime code.

## Recommendation

Do not add Morph Fast Apply to the note placement path now. The current apply operation is already a deterministic in-process string splice. Adding Morph after Gemma would add a network round trip that returns an entire note. Replacing Gemma with Morph instead is a different experiment: the uncertain part is whether its instruction-driven merge can choose an appropriate note location quickly and preserve all other text. Fast Apply is designed to merge an edit snippet chosen by another model into a full source file; its documented examples do not establish semantic placement quality for this note workflow, and it does not provide the optimistic-concurrency contract the note editor needs.

The smallest native path remains the existing one: have Gemma produce a short anchored insertion, validate that it is additive and verbatim, resolve it locally, then apply it to the latest draft only if the anchor remains valid. Improve perceived speed by tuning or specializing the placement generation call and by showing the existing placement-progress state, rather than introducing another apply provider.

## What Morph Fast Apply actually does

Morph's Apply API is an OpenAI-compatible `POST /v1/chat/completions` request. Its input is one user message containing `<instruction>`, the complete `<code>`, and an `<update>` snippet. Its response content is the complete merged file. The API offers `morph-v3-fast`, `morph-v3-large`, and `auto`, temperature zero for deterministic output, and optional OpenAI-style SSE streaming. [Morph Apply API](https://docs.morphllm.com/api-reference/endpoint/apply)

Morph describes the product as the mechanical merge stage after a planning model has already decided the edit. Its own agent guidance tells the agent to read the target first, provide focused edits with surrounding context and “existing code” markers, and read again to verify the result. [Morph agent-tool guidance](https://docs.morphllm.com/guides/agent-tools)

This contract can carry Markdown as text, and Morph markets Fast Apply for “code or files” and structured formats including editor JSON. However, the public Apply reference and published benchmarks do not document a Markdown-specific preservation guarantee or a Markdown benchmark. Markdown compatibility should therefore be treated as plausible generic-text behavior, not an established safety property.

Morph currently advertises the following for `morph-v3-fast`: 262K context, 10,500+ output tokens/second, sub-second cold starts, 98% accuracy, and prices of $0.80 per million input tokens and $1.20 per million output tokens. The larger model is listed at 5,000+ tokens/second and $0.90/$1.90 per million input/output tokens. These figures are provider claims. [Morph model and pricing page](https://www.morphllm.com/models)

Token throughput is not end-to-end latency. Morph's own published benchmark reports apply times around 1.4–3.4 seconds for its tested coding-agent tasks, despite the 10,500-token/second generation rate. Those tests measure coding edits and are not measurements of this application, Cloudflare Workers, short notes, or network distance. [Morph Fast Apply benchmark](https://www.morphllm.com/benchmarks/fast-apply)

Streaming is supported, but it does not make partial output safe to apply. Each streamed delta is only a prefix of the replacement full file. The client must buffer the complete response, validate it, and then commit one transaction. Applying deltas into the live editor would expose incomplete Markdown and make concurrent typing much harder to preserve.

## Existing note path

The application already separates placement from application:

1. The capture endpoint checks the saved note revision, asks the existing Gemma agent for `oldText` and `newText`, and validates the result with `resolveEdit`.
2. Explicit capture must resolve to a pure insertion and must contain the selected user text verbatim. The server rejects replacement or deletion of surrounding note text.
3. `resolveEdit` requires `oldText` to occur exactly once. It reduces the old/new pair to the smallest UTF-16 range and inserted text.
4. While placement is running, the editor remains usable. On response, `resolveCapturePlacement` reads the latest draft and reapplies the proposal against that draft. Typing elsewhere survives. If typing changed the unique anchor, the client refreshes placement once and then returns a conflict rather than overwriting the draft.
5. Durable acceptance still uses the note's base revision, and provenance is shifted through the same local edit.

This is cheaper and safer than full-note replacement. For a valid proposal, the apply work is two substring searches plus one splice. It has no model latency. The tests explicitly cover preserving text typed elsewhere and refusing to overwrite typing inside the anchor.

## Why Fast Apply is a poor fit here

Fast Apply solves ambiguous or drifted code-edit snippets by regenerating the complete target file. This application deliberately rejects ambiguity instead. A unique anchor is part of the authorization and conflict boundary: it proves the small insertion can still be placed without changing other user-authored text.

Replacing that boundary with a full-note output would require sending the whole note and edit to an additional provider, buffering the whole response, diffing it locally, proving the diff is exactly one permitted insertion containing the captured text verbatim, rebasing or retrying against concurrent typing, updating provenance from the derived range, and retaining the existing revision checks. If all those checks pass, the result is the same small splice already computed locally. If they fail, the product still needs the current anchored fallback.

For explicit Add to note, the selected text already supplies the update snippet. We could test replacing Gemma with Morph using an instruction to insert it in the most appropriate section, rather than adding a second model call. That may reduce latency, but the published coding benchmarks do not establish its placement quality or speed on our Markdown notes. For unsolicited suggestions, selecting what is worth recording remains a separate responsibility. Appending Morph after that existing full placement call would add serial latency; compare replacement pipelines instead.

The concurrency rule should remain unchanged for any future provider: capture a revision and draft snapshot, never apply streamed partial text, validate the complete candidate as an allowed minimal edit, resolve it against the current CodeMirror document, dispatch one CodeMirror transaction, and let the existing revision-aware save path commit it. A provider response must never be allowed to replace the editor value directly.

## A future evidence-gathering spike

Reconsider Fast Apply only if telemetry shows that anchor-generation retries are a material latency or failure source on long, highly repetitive notes. A bounded evaluation would compare Morph and Gemma independently on the same note snapshot, selected text, and placement instruction, without serially chaining them. It would use `morph-v3-fast`, temperature zero, a short deadline, and non-streaming completion (or buffered streaming), then measure:

- end-to-end p50/p95 latency, including connection startup;
- exact preservation of every pre-existing Markdown character;
- whether the output diff is one additive insertion containing the capture verbatim;
- behavior on duplicate headings, repeated bullets, fenced code, tables, links, and Unicode;
- conflicts when the user types outside and inside the proposed location;
- full-note input/output token cost and provider failure rate.

The provider should remain disabled unless that comparison beats the current anchored path on user-visible latency or placement success while passing every preservation and concurrency invariant. No new SDK is needed for such a spike because the endpoint accepts ordinary `fetch`; introducing a general provider abstraction before those results would add structure without proven value.
