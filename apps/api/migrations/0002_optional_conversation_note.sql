PRAGMA defer_foreign_keys = ON;

CREATE TABLE conversations_new (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
  persona_id TEXT,
  persona_snapshot_json TEXT,
  learning_consent INTEGER NOT NULL DEFAULT 0,
  last_user_activity_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
INSERT INTO conversations_new SELECT * FROM conversations;

CREATE TABLE turns_new (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations_new(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(owner_id, request_id)
);
INSERT INTO turns_new SELECT * FROM turns;

CREATE TABLE messages_new (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations_new(id) ON DELETE CASCADE,
  turn_id TEXT REFERENCES turns_new(id) ON DELETE SET NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  annotations_json TEXT NOT NULL DEFAULT '[]',
  incomplete INTEGER NOT NULL DEFAULT 0,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(conversation_id, sequence)
);
INSERT INTO messages_new SELECT * FROM messages;

CREATE TABLE interventions_new (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations_new(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL REFERENCES turns_new(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
INSERT INTO interventions_new SELECT * FROM interventions;

DROP TABLE interventions;
DROP TABLE messages;
DROP TABLE turns;
DROP TABLE conversations;

ALTER TABLE conversations_new RENAME TO conversations;
ALTER TABLE turns_new RENAME TO turns;
ALTER TABLE messages_new RENAME TO messages;
ALTER TABLE interventions_new RENAME TO interventions;

CREATE INDEX conversations_expiry ON conversations(status, expires_at);
CREATE UNIQUE INDEX one_streaming_turn ON turns(conversation_id) WHERE status='streaming';
CREATE INDEX messages_conversation ON messages(conversation_id, sequence);
CREATE UNIQUE INDEX one_pending_intervention ON interventions(conversation_id) WHERE status='pending';

PRAGMA defer_foreign_keys = OFF;
