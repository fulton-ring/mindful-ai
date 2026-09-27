# Product analytics

Walden sends named browser events to PostHog when the Account → Browser analytics preference is on. It does not use autocapture or session recording. Server-side `chat_generation_failed` and `chat_turn_started`, `chat_turn_recovered`, and `chat_turn_terminal` are operational telemetry and can arrive after a browser disconnects. Events contain IDs, counts, bounded categories, and durations; they do not contain prompts, note text, filenames, URLs from sources, or exception messages.

## What to chart in PostHog

| Question | Events and breakdown |
| --- | --- |
| What do people use? | Trend `chat_submitted`, `note_saved`, `note_capture_completed`, `note_suggestion_requested`, `chat_regeneration_started`, `file_upload_started`, `chat_preference_changed`, `persona_selected`, `settings_section_opened`; break chat and settings down by `action` and preferences by `setting`. |
| Where do they get stuck? | Trend `action_blocked`, `file_upload_blocked`, `note_save_failed`, `note_suggestion_failed`, `conversation_action_failed`; break down by `action`, `failure_code`, and `stage`. |
| Does chat work? | Funnel `chat_submitted` → `chat_completed`, with `chat_failed` as a separate trend. Break failures down by `failure_code`, `stage`, and `had_partial_response`. |
| Does upload work? | Funnel `file_upload_started` → `file_upload_completed`; break `file_upload_failed` down by `failure_code`, `file_type`, and `size_bucket`. |
| What fails after a disconnect? | Trend server event `chat_generation_failed`; break down by `failure_code`, `model`, `had_partial_response`, and `tool_count`. Correlate with Worker logs by `turn_id`. |
| Are durable turns recovering? | Trend `chat_turn_started`, `chat_turn_recovered`, and `chat_turn_terminal`; break terminal events down by `status` and recovered events by `attempt`. Join server and browser events by `request_id`; use `turn_id` for D1 and Workflow lookup. |
| Where does time before the first token go? | Chart `queue_ms` on `chat_turn_started`: time from turn reservation to the Workflow starting. Compare the `chat_submitted` → `chat_turn_started` gap by `request_id` to separate admission from Workflow scheduling. Highlights no longer delay completion; they arrive through the follow-up annotation stream after `chat_completed`. |

Browser analytics can be off, so browser funnels describe opted-in browsers rather than all users. Server failure counts and browser failure counts can overlap; do not add them together. A disabled control cannot emit a native click event. The chat send button, Add files action, and Connectors tab use `aria-disabled` with guarded handlers so attempted clicks can be counted without performing the action. Other disabled controls remain excluded from attempt counts.
