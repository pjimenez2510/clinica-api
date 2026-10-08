-- encounter_on_hold
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- EN-128: LA ATENCIÓN SUSPENDIDA, CON SU MOTIVO, SU AUTOR Y SU INSTANTE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El paciente sale —al laboratorio de enfrente— y va a volver. `ON_HOLD` ya
-- existía en el enum y en la tabla de transiciones (EN-132); lo que faltaba es
-- POR QUÉ salió, QUIÉN lo registró y DESDE CUÁNDO. Sin eso el estado no sabe
-- decir nada, y reanudar no tenía autor.
--
-- `held_*` es la suspensión vigente o la última; el historial (EN-133) guarda
-- cada una con su motivo en `encounter_status_history.reason`, así que la
-- segunda salida del día no borra la primera. Los autores son USUARIOS, como
-- los de interrumpir y anular.

ALTER TABLE "encounter"
  ADD COLUMN "hold_reason"   VARCHAR(500),
  ADD COLUMN "held_by_id"    UUID,
  ADD COLUMN "held_at"       TIMESTAMPTZ(6),
  ADD COLUMN "resumed_by_id" UUID,
  ADD COLUMN "resumed_at"    TIMESTAMPTZ(6);

ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_held_by_fk"
    FOREIGN KEY ("held_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT,
  ADD CONSTRAINT "encounter_resumed_by_fk"
    FOREIGN KEY ("resumed_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT;

-- En `ON_HOLD` hay motivo escrito, autor e instante. Ninguna atención de la
-- base del autor está hoy en `ON_HOLD` (08-10-2026: no había ruta), así que
-- la restricción entra validada.
ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_on_hold_states_who_when_and_why"
  CHECK (
    "status" <> 'ON_HOLD'
    OR (
      "hold_reason" IS NOT NULL AND btrim("hold_reason") <> ''
      AND "held_by_id" IS NOT NULL
      AND "held_at" IS NOT NULL
    )
  );

-- Los dos de cada acto, juntos o ninguno.
ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_hold_stamped"
    CHECK (("held_by_id" IS NULL) = ("held_at" IS NULL)
           AND ("held_by_id" IS NULL) = ("hold_reason" IS NULL)),
  ADD CONSTRAINT "encounter_resume_stamped"
    CHECK (("resumed_by_id" IS NULL) = ("resumed_at" IS NULL));

-- El motivo viaja a la fila del historial, que es inmutable.
ALTER TABLE "encounter_status_history" ADD COLUMN "reason" VARCHAR(500);

-- El motivo sólo en la fila de la suspensión.
ALTER TABLE "encounter_status_history"
  ADD CONSTRAINT "encounter_status_history_reason_only_on_hold"
  CHECK ("reason" IS NULL OR "fact" = 'PUT_ON_HOLD');

-- La misma función que `20261008013559_encounter_status_history_named_writer`,
-- con el autor, el instante y el motivo de suspender y reanudar.
CREATE OR REPLACE FUNCTION encounter_status_history_record()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_fact  "encounter_status_fact";
  v_by    UUID;
  v_at    TIMESTAMPTZ;
  v_from  "encounter_status";
  v_reason VARCHAR(500);
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
        v_by := NEW."held_by_id";
        v_at := NEW."held_at";
        v_reason := NEW."hold_reason";
      WHEN 'OPEN' THEN
        v_fact := 'RESUMED';
        v_by := NEW."resumed_by_id";
        v_at := NEW."resumed_at";
      ELSE
        RAISE EXCEPTION
          'encounter_status_history_unknown_status: no act is known for the state %', NEW."status"
          USING ERRCODE = 'integrity_constraint_violation',
                HINT = 'EN-133: add the state to encounter_status_fact and to this function.';
    END CASE;
  END IF;

  PERFORM set_config('app.encounter_status_trail', NEW."id"::text, true);
  INSERT INTO "encounter_status_history"
    ("encounter_id", "from_status", "to_status", "fact", "changed_by_id", "changed_at", "reason")
  VALUES (NEW."id", v_from, NEW."status", v_fact, v_by,
          COALESCE(v_at, NEW."updated_at"), v_reason);
  PERFORM set_config('app.encounter_status_trail', '', true);
  RETURN NULL;
END;
$$;

