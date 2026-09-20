CREATE TABLE account_privacy (
  owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  disclosure_version TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision TEXT NOT NULL
);
-- Kept independently of account deletion until the provider accepts the request.
CREATE TABLE telemetry_deletions (
  distinct_id TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL
);
