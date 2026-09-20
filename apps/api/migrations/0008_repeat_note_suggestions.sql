CREATE TABLE note_suggestions_new (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT,
  source_message_id TEXT,
  base_revision INTEGER NOT NULL,
  base_markdown TEXT NOT NULL,
  old_text TEXT NOT NULL,
  new_text TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decision_edit_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);

INSERT INTO note_suggestions_new (
  id,note_id,owner_id,conversation_id,source_message_id,base_revision,base_markdown,
  old_text,new_text,reason,status,decision_edit_id,created_at,updated_at,decided_at
)
SELECT id,note_id,owner_id,conversation_id,source_message_id,base_revision,base_markdown,
  old_text,new_text,reason,status,decision_edit_id,created_at,updated_at,decided_at
FROM note_suggestions;

DROP TABLE note_suggestions;
ALTER TABLE note_suggestions_new RENAME TO note_suggestions;

CREATE UNIQUE INDEX one_pending_note_suggestion_per_source
ON note_suggestions(owner_id, conversation_id, source_message_id)
WHERE status='pending';

CREATE INDEX note_suggestions_note_status
ON note_suggestions(note_id, status, created_at DESC);
