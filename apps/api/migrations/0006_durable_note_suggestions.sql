ALTER TABLE note_edits ADD COLUMN kind TEXT NOT NULL DEFAULT 'user_edit';
ALTER TABLE note_edits ADD COLUMN suggestion_id TEXT;
ALTER TABLE note_edits ADD COLUMN before_suggestion_status TEXT;
ALTER TABLE note_edits ADD COLUMN after_suggestion_status TEXT;
ALTER TABLE note_edits ADD COLUMN discarded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE note_edits ADD COLUMN undone_at TEXT;

CREATE TABLE note_suggestions (
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
  decided_at TEXT,
  UNIQUE(owner_id, conversation_id, source_message_id)
);
CREATE INDEX note_suggestions_note_status ON note_suggestions(note_id, status, created_at DESC);

CREATE TABLE note_history_requests (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  edit_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, note_id, operation_id)
);
