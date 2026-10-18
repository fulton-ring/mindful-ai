ALTER TABLE conversations ADD COLUMN retention_disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN purge_started_at TEXT;
ALTER TABLE conversations ADD COLUMN purge_token TEXT;
