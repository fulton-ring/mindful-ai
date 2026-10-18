-- Locks are shared with application transactions. Never use an unlocked read/check trigger:
-- at READ COMMITTED two concurrent admissions can both observe an empty branch.
CREATE FUNCTION lock_turn_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('owner:' || NEW.owner_id,0));
  RETURN NEW;
END;
$$;
CREATE TRIGGER cancellation_owner_lock BEFORE INSERT ON turn_cancellations
  FOR EACH ROW EXECUTE FUNCTION lock_turn_owner();

CREATE FUNCTION enforce_turn_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE branch_key text;
BEGIN
  IF TG_OP='UPDATE' AND NEW.status<>'streaming' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('owner:' || NEW.owner_id,0));
  FOR branch_key IN SELECT DISTINCT unnest(ARRAY[NEW.branch_id,NEW.source_branch_id]) ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('branch:' || branch_key,0));
  END LOOP;
  IF EXISTS(SELECT 1 FROM turn_cancellations WHERE owner_id=NEW.owner_id AND request_id=NEW.request_id) THEN
    RAISE EXCEPTION 'Turn cancelled before admission' USING ERRCODE='23514';
  END IF;
  IF NEW.status='streaming' AND EXISTS (
    SELECT 1 FROM turns t WHERE t.status='streaming' AND t.id<>NEW.id AND (
      t.branch_id IN (NEW.branch_id,NEW.source_branch_id) OR
      t.source_branch_id IN (NEW.branch_id,NEW.source_branch_id)
    )
  ) THEN
    RAISE EXCEPTION 'A turn is already in progress for this branch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER turn_admission BEFORE INSERT OR UPDATE OF status,branch_id,source_branch_id ON turns
  FOR EACH ROW EXECUTE FUNCTION enforce_turn_admission();
