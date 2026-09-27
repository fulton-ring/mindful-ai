# Settings follow-ups

Implemented locally:

- Account-level conversation sharing, default on in first-use disclosure, with server enforcement and PostHog deletion queue. See customer-data-policy.md for deployment prerequisites.
- Public Privacy Policy and Terms identify Fulton Ring and info@fultonring.com; policy matches collection boundaries. Legal review before broad launch remains an operator action.
- Study partner default persona: active recall, one question at a time, hints and feedback; respects disabled learning checks and requests for direct answers. Browser testing exposed a runaway model continuation after a completed learning-check tool call; the model loop now stops once a check is ready for the user. Tool schema descriptions distinguish answer choices from topic menus. Retest produced a concrete chlorophyll question with four answers and completed cleanly.
- Automatic search: the keyword rules and forced first-step tool choice were removed. General system instructions ask the agent to judge freshness, uncertainty, and the need for evidence, then use searchWeb when needed. No classifier or extra service.
- Learning checks: persistent on/off checkbox in Chat tools; saves directly to the conversation, supports re-enabling, and does not create a chat turn. The control is disabled while a reply is running. Study Partner's editable prompt owns its quiz frequency; no persona-ID special case remains.
- Critical reader is now Challenger, with instructions to stress-test ideas, seek evidence and counterarguments, and avoid reflexive disagreement. The existing ID is retained so saved references continue working.

Durability remains on its separate WIP branch. The v1 generation timeout remains five minutes.

The persona model field uses the existing shared Select components and modal combobox styling, remains disabled on Gemma 4, and has no redundant explanatory line. Verified visually in the browser.
