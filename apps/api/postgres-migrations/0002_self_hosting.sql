-- Existing identities are Clerk identities; ownership UUIDs never change.
ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'clerk';

DROP INDEX users_auth_subject_unique;

CREATE UNIQUE INDEX users_auth_identity_unique ON users(auth_provider,auth_subject);

CREATE TABLE app_settings (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);

ALTER TABLE turns ADD COLUMN execution_generation INTEGER NOT NULL DEFAULT 0 CHECK(execution_generation>=0);

ALTER TABLE turns ADD COLUMN descriptor_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE turns ADD COLUMN descriptor_json TEXT;

-- Sequence is monotonic for the entire turn, including recovered generations.
CREATE TABLE turn_events (
  turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(generation>=0),
  sequence INTEGER NOT NULL CHECK(sequence>=0),
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(turn_id,sequence)
);

CREATE INDEX turn_events_created_at ON turn_events(created_at);

CREATE TABLE auth_user (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  image TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE auth_session (
  id TEXT PRIMARY KEY NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE
);

CREATE INDEX auth_session_user ON auth_session(user_id);

CREATE TABLE auth_account (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  refresh_token_expires_at TIMESTAMPTZ,
  scope TEXT,
  password TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX auth_account_user ON auth_account(user_id);

CREATE TABLE auth_verification (
  id TEXT PRIMARY KEY NOT NULL,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX auth_verification_identifier ON auth_verification(identifier);

CREATE TABLE research_sources (
  id TEXT PRIMARY KEY NOT NULL,
  owner_scope TEXT NOT NULL,
  source_url TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_scope,source_url)
);

CREATE INDEX research_sources_owner_scope ON research_sources(owner_scope);

CREATE TABLE research_chunks (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES research_sources(id) ON DELETE CASCADE,
  owner_scope TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  UNIQUE(source_id,ordinal)
);

CREATE INDEX research_chunks_owner_scope ON research_chunks(owner_scope);

CREATE TABLE research_indexing_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  owner_scope TEXT NOT NULL,
  source_url TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','complete','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_scope,source_url)
);

CREATE INDEX research_indexing_jobs_owner_scope ON research_indexing_jobs(owner_scope);


CREATE INDEX research_chunks_fts ON research_chunks USING gin(to_tsvector('english',text));

CREATE UNIQUE INDEX auth_account_identity ON auth_account(provider_id,account_id);
