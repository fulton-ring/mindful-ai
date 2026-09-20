ALTER TABLE personas ADD COLUMN icon TEXT CHECK (icon IS NULL OR icon IN ('compass','swords','graduation-cap','lightbulb','book','flask','pencil','user'));
