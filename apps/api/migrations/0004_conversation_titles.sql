ALTER TABLE conversations ADD COLUMN title TEXT NOT NULL DEFAULT 'New conversation';

UPDATE conversations
SET title = COALESCE(
  (SELECT CASE WHEN TRIM(n.title) = 'Untitled note' THEN NULL ELSE NULLIF(TRIM(n.title), '') END
    FROM notes n WHERE n.id = conversations.note_id),
  (SELECT NULLIF(TRIM(m.content), '') FROM messages m
    WHERE m.conversation_id = conversations.id AND m.role = 'user'
    ORDER BY m.sequence LIMIT 1),
  'New conversation'
);

ALTER TABLE notes DROP COLUMN title;
