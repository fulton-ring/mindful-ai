ALTER TABLE note_suggestions ADD COLUMN generation_key TEXT;

UPDATE note_suggestions SET generation_key=source_message_id WHERE generation_key IS NULL;

DROP INDEX one_pending_note_suggestion_per_branch_source;
CREATE UNIQUE INDEX one_pending_note_suggestion_per_generation
ON note_suggestions(owner_id,conversation_id,branch_id,generation_key)
WHERE status='pending';
