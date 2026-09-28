# Product analytics

Walden sends named browser events to PostHog when the Account → Browser analytics preference is on. It does not use autocapture or session recording. Server-side `chat_generation_failed`, `chat_turn_started`, `chat_turn_terminal`, `message_limit_reached`, and `message_limit_blocked` are operational telemetry and can arrive after a browser disconnects. Events contain IDs, counts, bounded categories, and durations; they do not contain prompts, note text, filenames, URLs from sources, or exception messages.

## What to chart in PostHog

| Question | Events and breakdown |
| --- | --- |
| What do people use? | Trend `chat_submitted`, `note_saved`, `note_capture_completed`, `note_suggestion_requested`, `chat_regeneration_started`, `file_upload_started`, `chat_preference_changed`, `persona_selected`, `settings_section_opened`; break chat and settings down by `action` and preferences by `setting`. |
| Where do they get stuck? | Trend `action_blocked`, `file_upload_blocked`, `note_save_failed`, `note_suggestion_failed`, `conversation_action_failed`; break down by `action`, `failure_code`, and `stage`. |
| Does chat work? | Funnel `chat_submitted` → `chat_completed`, with `chat_failed` as a separate trend. Break failures down by `failure_code`, `stage`, and `had_partial_response`. |
| Does upload work? | Funnel `file_upload_started` → `file_upload_completed`; break `file_upload_failed` down by `failure_code`, `file_type`, and `size_bucket`. |
| What fails after a disconnect? | Trend server event `chat_generation_failed`; break down by `failure_code`, `model`, `had_partial_response`, and `tool_count`. Correlate with Worker logs by `turn_id`. |
| Are turns finishing? | Trend `chat_turn_started` and `chat_turn_terminal`; break terminal events down by `status`. Join server and browser events by `request_id`; use `turn_id` for D1 lookup. |
| When do people hit the message limit, and how fast? | Server event `message_limit_reached` fires on the send that uses up the budget; `ms_since_window_start` is how long the window took to fill, with `turns_in_window`, `used`, `limit`, `window_hours`, and the `model` and `weight` of that send. `message_limit_blocked` fires for each send refused at the limit, with `ms_until_reset`. Chart the median `ms_since_window_start`, and count distinct users with `message_limit_reached` per day. |
| Where does time before the first token go? | Chart `queue_ms` on `chat_turn_started`: time from turn reservation to the turn's Durable Object starting it. Compare the `chat_submitted` → `chat_turn_started` gap by `request_id` to separate the browser round trip from admission. Highlights no longer delay completion; they arrive through the follow-up annotation stream after `chat_completed`. |

Browser analytics can be off, so browser funnels describe opted-in browsers rather than all users. Server failure counts and browser failure counts can overlap; do not add them together. A disabled control cannot emit a native click event. The chat send button, Add files action, and Connectors tab use `aria-disabled` with guarded handlers so attempted clicks can be counted without performing the action. Other disabled controls remain excluded from attempt counts.
