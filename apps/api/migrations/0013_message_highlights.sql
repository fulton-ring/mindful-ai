CREATE TABLE message_highlights (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  quote TEXT NOT NULL,
  color TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (message_id,start,end),
  CHECK (start>=0 AND end>start),
  CHECK (color IS NULL OR color IN ('yellow','green','blue','pink','purple'))
);
CREATE INDEX message_highlights_owner_message ON message_highlights(owner_id,message_id);
