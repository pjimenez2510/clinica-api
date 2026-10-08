-- encounter_status_history_named_writer
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- EN-133: EL ESCRITOR DEL HISTORIAL SE IDENTIFICA, Y UN ESTADO NUEVO SE NOMBRA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Revisión de código de `feat/f04-atencion-y-nota`:
--   · La guarda `pg_trigger_depth() < 2` dejaba pasar un INSERT hecho desde
--     CUALQUIER disparador. Ahora `encounter_status_history_record` marca la
--     transacción con la atención que está escribiendo
--     (`app.encounter_status_trail`, local a la transacción) y la guarda exige
--     esa marca para esa atención; la borra al terminar.
--   · `CASE NEW.status` sin `ELSE` fallaba con `case_not_found` ante un valor
--     nuevo del enum, sin nombrar la regla. Ahora lo dice, con el nombre
--     primero, como lo lee `database-problem.ts`. Sigue fallando cerrado: un
--     estado que el historial no sabe nombrar no entra sin su hecho.

CREATE OR REPLACE FUNCTION encounter_status_history_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_fact  "encounter_status_fact";
  v_by    UUID;
  v_at    TIMESTAMPTZ;
  v_from  "encounter_status";
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_fact := 'OPENED';
    v_by := NEW."opened_by_id";
    v_at := NEW."created_at";
    v_from := NULL;
  ELSE
    IF OLD."status" IS NOT DISTINCT FROM NEW."status" THEN
      RETURN NULL;
    END IF;
    v_from := OLD."status";
    CASE NEW."status"
      WHEN 'DISCHARGED' THEN
        v_fact := 'NOTE_SIGNED';
        SELECT p."user_id", n."signed_at" INTO v_by, v_at
          FROM "clinical_note" n
          JOIN "practitioner" p ON p."id" = n."signed_by_id"
         WHERE n."encounter_id" = NEW."id"
           AND n."form_code" = '002'
           AND n."signed_at" IS NOT NULL
         ORDER BY n."signed_at" DESC, n."id" DESC
         LIMIT 1;
        v_at := COALESCE(NEW."ended_at", v_at);
      WHEN 'COMPLETED' THEN
        v_fact := 'ACCOUNT_CLOSED';
        SELECT p."user_id" INTO v_by FROM "practitioner" p WHERE p."id" = NEW."closed_by_id";
        v_at := NEW."closed_at";
      WHEN 'DISCONTINUED' THEN
        v_fact := 'INTERRUPTED';
        v_by := NEW."discontinued_by_id";
        v_at := NEW."discontinued_at";
      WHEN 'ENTERED_IN_ERROR' THEN
        v_fact := 'ANNULLED';
        v_by := NEW."entered_in_error_by_id";
        v_at := NEW."entered_in_error_at";
      WHEN 'ON_HOLD' THEN
        v_fact := 'PUT_ON_HOLD';
      WHEN 'OPEN' THEN
        v_fact := 'RESUMED';
      ELSE
        RAISE EXCEPTION
          'encounter_status_history_unknown_status: no act is known for the state %', NEW."status"
          USING ERRCODE = 'integrity_constraint_violation',
                HINT = 'EN-133: add the state to encounter_status_fact and to this function.';
    END CASE;
  END IF;

  PERFORM set_config('app.encounter_status_trail', NEW."id"::text, true);
  INSERT INTO "encounter_status_history"
    ("encounter_id", "from_status", "to_status", "fact", "changed_by_id", "changed_at")
  VALUES (NEW."id", v_from, NEW."status", v_fact, v_by,
          COALESCE(v_at, NEW."updated_at"));
  PERFORM set_config('app.encounter_status_trail', '', true);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION encounter_status_history_only_from_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() < 2
     OR COALESCE(current_setting('app.encounter_status_trail', true), '')
        <> NEW."encounter_id"::text THEN
    RAISE EXCEPTION
      'encounter_status_history_written_by_trigger: the state trail of an attention is written only by the database when the state changes'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'EN-133: change encounter.status and the trail follows.';
  END IF;
  IF NEW."to_status" IS DISTINCT FROM
     (SELECT e."status" FROM "encounter" e WHERE e."id" = NEW."encounter_id") THEN
    RAISE EXCEPTION
      'encounter_status_history_written_by_trigger: the row does not match the state of the attention'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'EN-133.';
  END IF;
  RETURN NEW;
END;
$$;
