CREATE UNIQUE INDEX one_conversation_per_note
ON conversations(note_id)
WHERE note_id IS NOT NULL;
