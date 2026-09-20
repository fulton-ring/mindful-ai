-- Agent marks lived in messages.annotations_json while user marks lived in
-- message_highlights, so a regenerate had no way to know which rows it owned.
-- One table with an origin discriminator makes that a DELETE ... WHERE
-- origin='agent'. Not user facing yet, so the old rows are discarded rather
-- than migrated.
DROP TABLE IF EXISTS message_highlights;

CREATE TABLE message_highlights (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'agent' rows are regenerable model output; 'user' rows are owned by the
  -- person and are never replaced by a regenerate.
  origin TEXT NOT NULL DEFAULT 'user',
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  quote TEXT NOT NULL,
  -- User rows: a colour, or NULL as a durable removal that also suppresses an
  -- overlapping agent mark. Agent rows leave this NULL; kind drives their wash.
  color TEXT,
  kind TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (message_id,origin,start,end),
  CHECK (origin IN ('user','agent')),
  CHECK (start>=0 AND end>start),
  CHECK (color IS NULL OR color IN ('yellow','green','blue','pink','purple')),
  CHECK (origin='user' OR color IS NULL)
);
CREATE INDEX message_highlights_owner_message ON message_highlights(owner_id,message_id);
CREATE INDEX message_highlights_message_origin ON message_highlights(message_id,origin);

ALTER TABLE messages DROP COLUMN annotations_json;
