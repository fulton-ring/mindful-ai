CREATE TABLE conversation_branches (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  head_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  forked_from_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  last_user_activity_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX one_default_conversation_branch
  ON conversation_branches(conversation_id) WHERE is_default=1;
CREATE INDEX conversation_branches_expiry ON conversation_branches(status,expires_at);

ALTER TABLE messages ADD COLUMN parent_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN origin_branch_id TEXT REFERENCES conversation_branches(id) ON DELETE SET NULL;
ALTER TABLE turns ADD COLUMN branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE;
ALTER TABLE interventions ADD COLUMN branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE;
ALTER TABLE note_suggestions ADD COLUMN branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE;

INSERT INTO conversation_branches
  (id,conversation_id,owner_id,is_default,status,last_user_activity_at,expires_at,created_at)
SELECT 'branch:'||id,id,owner_id,1,status,last_user_activity_at,expires_at,created_at FROM conversations;

UPDATE messages SET
  parent_message_id=(SELECT prior.id FROM messages prior WHERE prior.conversation_id=messages.conversation_id AND prior.owner_id=messages.owner_id AND prior.sequence<messages.sequence ORDER BY prior.sequence DESC LIMIT 1),
  origin_branch_id='branch:'||conversation_id;
UPDATE conversation_branches SET head_message_id=(SELECT id FROM messages WHERE conversation_id=conversation_branches.conversation_id AND owner_id=conversation_branches.owner_id ORDER BY sequence DESC LIMIT 1);
UPDATE turns SET branch_id='branch:'||conversation_id;
UPDATE interventions SET branch_id='branch:'||conversation_id;
UPDATE note_suggestions SET branch_id='branch:'||conversation_id
WHERE conversation_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM conversation_branches b WHERE b.id='branch:'||note_suggestions.conversation_id);

DROP INDEX one_streaming_turn;
DROP INDEX one_pending_intervention;
DROP INDEX one_pending_note_suggestion_per_source;
CREATE UNIQUE INDEX one_streaming_turn_per_branch ON turns(branch_id) WHERE status='streaming';
CREATE UNIQUE INDEX one_pending_intervention_per_branch ON interventions(branch_id) WHERE status='pending';
CREATE UNIQUE INDEX one_pending_note_suggestion_per_branch_source
  ON note_suggestions(owner_id,conversation_id,branch_id,source_message_id) WHERE status='pending';
