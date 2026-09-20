-- A note outlives the conversation that started it, so its name cannot be a
-- property of that conversation. Migration 0004 moved titles onto
-- `conversations` and left notes deriving their name through a subquery, which
-- inverts the ownership: the note is the durable object and the conversation is
-- a child of it. Give the note its own title and make it the source of truth.
ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT '';

UPDATE notes
SET title = COALESCE(
  (SELECT NULLIF(TRIM(c.title), '') FROM conversations c
    WHERE c.note_id = notes.id AND c.owner_id = notes.owner_id
    ORDER BY c.last_user_activity_at DESC LIMIT 1),
  ''
);
