-- Makes the access audit log genuinely append-only.
--
-- WHY A TRIGGER AND NOT `REVOKE UPDATE, DELETE`:
-- a table owner keeps its privileges even after you revoke them, and the
-- application connects as the owner. A REVOKE would give a false sense of
-- security. The trigger applies to everyone except a superuser who explicitly
-- disables it — and that does get recorded in the server logs.
--
-- Without this the log is not evidence: if the application administrator can
-- edit it, it proves nothing.

CREATE OR REPLACE FUNCTION access_audit_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'access_audit is append-only: operation % is forbidden', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'The audit log is legal evidence and cannot be altered. '
                 'To debug in development, disable the trigger explicitly.';
END;
$$;

CREATE TRIGGER trg_access_audit_immutable
  BEFORE UPDATE OR DELETE ON access_audit
  FOR EACH ROW
  EXECUTE FUNCTION access_audit_insert_only();

-- TRUNCATE does not fire FOR EACH ROW triggers: it needs its own.
CREATE TRIGGER trg_access_audit_no_truncate
  BEFORE TRUNCATE ON access_audit
  FOR EACH STATEMENT
  EXECUTE FUNCTION access_audit_insert_only();

COMMENT ON TABLE access_audit IS
  'Append-only log of access to personal and health data (LOPDP). '
  'Protected by trigger against UPDATE, DELETE and TRUNCATE.';
