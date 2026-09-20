-- Assistant replies carry no sender label, and the persona that produced them
-- was only recorded on the conversation, which holds the most recent one. That
-- makes a label wrong for every earlier reply once the persona is switched
-- mid-thread. Record the persona name on the message that used it.
ALTER TABLE messages ADD COLUMN persona_name TEXT;
