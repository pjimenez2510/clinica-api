-- privacy_authorization_one_standing_per_person
--
-- PD-071 (review of feat/ronda4-crear-corregir-privacidad). One standing
-- authorization per PERSON, purpose and channel — the chart and every chart
-- merged into it (PA-055) — and not per row of `patient`. Listing, revoking
-- and exporting already read the whole family; the rule only looked at the
-- chart written to, so after a merge of two duplicates that both had
-- «Publicidad por WhatsApp» the person stood twice authorized, and the
-- survivor could add a third.
--
-- The advisory lock is taken on the ROOT of the family, so a grant on the
-- survivor and one on an absorbed chart (refused by the service, but the base
-- does not trust it) are ordered too.
--
-- READ COMMITTED: every statement of this VOLATILE function takes a fresh
-- snapshot, so the second of two simultaneous grants sees the first once it
-- holds the lock. Under REPEATABLE READ or SERIALIZABLE it would not; no
-- caller of this table opens one.
--
-- TO UNDO: restore the function of 20261023100000.

CREATE OR REPLACE FUNCTION patient_authorization_one_standing()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  root UUID;
BEGIN
  SELECT COALESCE(p."merged_into_id", p."id") INTO root
    FROM "patient" p WHERE p."id" = NEW."patient_id";
  PERFORM pg_advisory_xact_lock(hashtextextended('patient_authorization:' || root::text, 0));
  IF EXISTS (
    SELECT 1
      FROM "patient_authorization" a
      JOIN "patient" p ON p."id" = a."patient_id"
     WHERE (p."id" = root OR p."merged_into_id" = root)
       AND a."purpose" = NEW."purpose"
       AND a."channel" IS NOT DISTINCT FROM NEW."channel"
       AND NOT EXISTS (
         SELECT 1 FROM "patient_authorization_revocation" r
          WHERE r."authorization_id" = a."id"
       )
  ) THEN
    RAISE EXCEPTION 'patient_authorization_one_standing: the person already has this authorization standing'
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'patient_authorization_one_standing',
            HINT = 'PD-071. Se revoca la vigente antes de volver a autorizar.';
  END IF;
  RETURN NEW;
END;
$$;

-- The hint of the shared insert-only function speaks for every table it
-- guards: the requests and their answers too.
CREATE OR REPLACE FUNCTION privacy_insert_only()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: operation % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Es prueba de protección de datos: se registra una fila nueva, no se reescribe.';
END;
$$;
