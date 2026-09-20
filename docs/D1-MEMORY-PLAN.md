# D1 observational memory implementation

Approved direction: keep Cloudflare D1 for native Mastra observational memory and R2 for workspace files. Implement storage support rather than a new summarization algorithm. Local testing only.

- [x] Extend MemoryStorageD1 with native observation records, generations, buffering, flags and cleanup. Use conditional writes for cross-request consistency; deleted records cannot be recreated by late updates.
- [x] Reconcile the complete unexpired canonical transcript rather than a 40-message sliding cache. Invalidate observations when already-observed history changes or disappears after regeneration.
- [x] Use Mastra's Observer/Reflector with the configured Cloudflare model and thread scope. Begin with awaited observation/reflection, no background buffers. Keep main-agent history writes disabled; UI/app transcript remains authoritative.
- [x] Confirm seven-day cleanup removes raw messages and all observation generations, retaining approved notes. Explicit deletion removes both note and memory.
- [x] Exercise the real native memory engine with controlled model output and D1-compatible SQL, including reload/second-instance retrieval, conflicts, regeneration and deletion.
- [x] Run focused checks and a local chat smoke test. Keep local services running. Document any remaining workspace/search configuration and background-execution limits.

Files: apps/api/src/agent/d1-observational-memory.ts (adapter), memory.ts (native engine integration), services/agent.ts (model/deadline integration), chat/conversations.ts (retention), corresponding tests and docs/AGENT-CONTEXT.md.

Verification: native engine test forced observation and reflection, reconstructed Memory/D1Store, and confirmed an actual agent prompt contains the persisted observation. Opt-in Cloudflare Gemma test passed with parseable observations persisted into a fresh instance. Chrome recall check on the synthetic reading-habit thread returned the correct habit, duration and time; note remained an unaccepted proposal. Adapter tests exercise CAS contention across instances, buffered reflection preservation, duplicate activation, and deletion. No deployment.

Remaining beyond this phase: background observation scheduling, live R2 credentials/bucket verification and workspace search configuration. New note-generation/fast-apply reports are queued in IMPLEMENTATION-ISSUES.md.
