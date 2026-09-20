CREATE TABLE hidden_personas (
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, persona_id)
);
