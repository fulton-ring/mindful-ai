-- Learning checks were gated by a regex that read "study", "learn" and
-- "understand" as consent to be quizzed, so the column recorded an inference
-- rather than a choice. The decision now belongs to the model, and this column
-- records only the one thing the user actually decides: whether they have
-- turned checks off for this thread. Everyone starts enabled.
ALTER TABLE conversations ADD COLUMN learning_checks_enabled INTEGER NOT NULL DEFAULT 1;
UPDATE conversations SET learning_checks_enabled = 1;
ALTER TABLE conversations DROP COLUMN learning_consent;
