-- Roadmap #39: live updates. A state transition and a notification each announce themselves on the
-- channel `hiva_events` from the transaction that writes them — PostgreSQL delivers a NOTIFY only when
-- that transaction commits, so a rolled-back move is never announced. The schema is named so that
-- listeners on one database but different schemas (the test isolation) hear only their own.

CREATE FUNCTION hiva_notify_transition() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('hiva_events', json_build_object(
    't', 'transition', 'schema', current_schema(), 'org', NEW."organizationId", 'entity', NEW."entityType",
    'id', NEW."entityId", 'from', NEW."fromState", 'to', NEW."toState", 'action', NEW."action",
    'actor', NEW."actorId", 'at', NEW."createdAt"
  )::text);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER "state_transitions_announce" AFTER INSERT ON "state_transitions" FOR EACH ROW EXECUTE FUNCTION hiva_notify_transition();

CREATE FUNCTION hiva_notify_notification() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('hiva_events', json_build_object(
    't', 'notification', 'schema', current_schema(), 'user', NEW."userId", 'kind', NEW."kind", 'severity', NEW."severity"
  )::text);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER "notifications_announce" AFTER INSERT ON "notifications" FOR EACH ROW EXECUTE FUNCTION hiva_notify_notification();
