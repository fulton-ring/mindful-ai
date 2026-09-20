# Local chat evaluation

## Reference prompt

“How is the 30 year yield linked to interest paid by high yield savings accounts?”

Evaluate responses for:

- A direct explanation that the relationship is indirect, with no mechanical peg between a 30-year Treasury yield and a savings APY.
- Short-term policy rates, competition for deposits, and bank funding needs as relevant savings-rate drivers.
- Expected future short-term rates and a term premium as distinct components of long-term Treasury yields.
- A clear possibility that the two rates can diverge; avoid asserting a forced or fixed pass-through from long bond yields into deposits.
- No invented current APYs or policy rates without a live source.
- A concise answer without an unnecessary quiz or claim that something was saved.

Sources for the conceptual rubric: [Federal Reserve research on deposit-rate pass-through](https://www.federalreserve.gov/econres/notes/feds-notes/changes-in-monetary-policy-and-banks-net-interest-margins-a-comparison-20190419.html), [New York Fed explanation of policy expectations and term premium](https://www.newyorkfed.org/newsevents/speeches/2023/per231116).

## September 18 baseline

Real Chrome → Clerk → local Worker → Mastra → Cloudflare Gemma turn completed with Markdown and semantic annotations visible. A fresh conversation had no inherited note, and its note panel remained closed.

Content quality needs improvement: the response correctly separated short- and long-term rates but overstated the causal mechanism with “forces banks” language and omitted term premium. This is a qualitative finding, not an automated pass score. General prompt guidance should distinguish shared drivers from direct causation; do not hardcode this question's answer.

UI checks: lists and bold text render correctly, annotations persist across reload, and explicit Add to note saves immediately. Model-initiated note proposals require an actual proposal tool result. An earlier synthetic test claimed a note was prepared without calling that tool; narrative text alone must never create a note.

PostHog will track metrics and events, not these message bodies. Evaluation examples in this document are manually selected synthetic or explicitly requested test prompts.

## September 18 follow-up

Repeated the exact prompt in a fresh conversation after the context/prompt changes, using the real local API and Cloudflare model. The answer completed, rendered Markdown and semantic highlights, and left the note panel closed.

The answer now includes term premium, bank liquidity needs, and the possibility of divergence. It still does **not** pass the factual-clarity rubric: its concluding analogy says the 30-year yield sets a “ceiling” for long-term borrowing costs. That is misleading, and the competition explanation continues to overstate the connection between long-duration bonds and liquid deposits. Record this as an unresolved model-quality issue; successful streaming and semantic labels are not evidence that an answer is correct. Avoid question-specific prompt patches or a claimed quantitative grade from this single sample.

## September 18 — bounded second evaluation

Added one general instruction: prefer literal mechanisms over unsolicited analogies, and avoid repeating a brief answer in a separate summary. Kept the model and token limit unchanged to avoid introducing truncation as a new variable.

- Exact yield prompt, fresh conversation: completed and rendered properly, with the note closed. The ceiling analogy disappeared, but term premium was omitted and the answer made unsupported generalizations about relative rate movements. Still below the factual-clarity rubric; no overall quality-pass claim.
- Independent prompt: “A city finds that ice cream sales and drownings both rise in summer. Does this show that buying ice cream causes drowning?” The answer correctly rejected proof of causation and identified warm weather/swimming as an alternative explanation. It nevertheless stated that explanation more definitively than the given data warranted, and repeated its conclusion. Partial success, with calibration and brevity still needing work.

These two samples are qualitative diagnostics, not a benchmark or evidence that prompt wording alone solves model reliability. Further work should target tool execution/state correctness and a small reproducible evaluation set before additional prompt tuning.

## September 18 — separate-secondary-call check

The yield prompt completed through the real Cloudflare model after splitting classification and note proposals out of the primary answer. Markdown and six possible semantic labels remain supported. This sample correctly denied a mechanical link but omitted term premium and again generalized about rates moving together/inflation-driven savings rates; it remains below the existing rubric.

A synthetic note request also exposed an unwanted refusal (“not a note-writing tool”) after separating note processing. Clarified the general prompt that note requests should be acknowledged and handled by the app's separate suggester, while still forbidding false claims that an edit was saved. Also clarified that the persona's brevity preference is not a reason to refuse a requested detailed answer. These prompt changes require a fresh behavioral check.

The note-language correction was checked with a fresh real-model response: it acknowledged the request, and the independent secondary call generated the ghost. A harmless fictional fern-note request also produced a reviewable proposal; “Thanks. No further changes to the fictional note.” returned “Understood.” without another visible suggestion. These checks verify behavior, not factual accuracy or a broad benchmark pass.
