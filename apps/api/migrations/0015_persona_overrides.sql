-- Editing a built-in persona saves a copy and hides the original. Without a
-- link back to what it replaced, the copy is appended after the remaining
-- built-ins, so the app's default persona (thinking-partner) disappears and
-- every new thread silently falls back to whichever persona happens to be
-- first. This records the built-in a custom persona stands in for so it can be
-- returned in that built-in's position.
ALTER TABLE personas ADD COLUMN replaces_persona_id TEXT;
CREATE UNIQUE INDEX personas_owner_replaces
  ON personas(owner_id, replaces_persona_id)
  WHERE replaces_persona_id IS NOT NULL;
