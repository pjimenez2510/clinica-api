-- account_closes_encounter
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- D-184 (aceptada por el autor el 08-10-2026): CAJA CIERRA LA ATENCIÓN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta hoy `COMPLETED` sólo lo alcanzaba `POST /encounters/:id/close`, que
-- ninguna pantalla llamaba: ninguna atención llegaba a cerrarse ni el paciente
-- a `DEPARTED`. Ahora cerrar la cuenta en caja cierra la atención que ya tiene
-- el alta, en la MISMA transacción (EN-131, EN-139, BI-236), y una cuenta sin
-- nada facturado se cierra con el motivo por el que no se cobra (BI-237).
--
-- NO TOCA NINGUNA FILA EXISTENTE. Añade dos columnas vacías, dos CHECK que las
-- filas actuales cumplen (ninguna atención de la base del autor está
-- `COMPLETED`, 08-10-2026: no había pantalla) y disparadores que sólo actúan
-- en el próximo cierre. Las cuentas ya liquidadas no se reevalúan, y sus
-- atenciones siguen `DISCHARGED` (D-186).

-- ── 1. Quién cerró la atención: un USUARIO, el de caja ─────────────────────
--
-- `closed_by_id` apunta a `practitioner` porque lo cerraba el médico
-- (D-A-010). Caja no es un profesional clínico, así que el autor del cierre
-- es su cuenta de usuario, como los de suspender, interrumpir y anular.
ALTER TABLE "encounter" ADD COLUMN "closed_by_user_id" UUID;

ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_closed_by_user_fk"
    FOREIGN KEY ("closed_by_user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT;

-- EN-131: cerrada es con quién y cuándo, por el camino nuevo o por el viejo.
ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_completed_states_who_and_when"
  CHECK (
    "status" <> 'COMPLETED'
    OR (
      "closed_at" IS NOT NULL
      AND ("closed_by_user_id" IS NOT NULL OR "closed_by_id" IS NOT NULL)
    )
  );

-- ── 2. Por qué no se cobra (BI-237) ────────────────────────────────────────
ALTER TABLE "patient_account" ADD COLUMN "no_charge_reason" VARCHAR(200);

ALTER TABLE "patient_account"
  ADD CONSTRAINT "patient_account_no_charge_reason_not_blank"
  CHECK ("no_charge_reason" IS NULL OR btrim("no_charge_reason") <> '');

-- Liquidar sin nada facturado exige el motivo. Un disparador y no un CHECK
-- porque «nada facturado» se lee en `charge_item`. Sólo en el paso de OPEN a
-- SETTLED: las cuentas ya liquidadas no se reevalúan.
--
-- Al REABRIRSE (tras una nota de crédito) el motivo se vacía: el cierre
-- siguiente dice el suyo. La versión anterior la guarda `record_version`.
CREATE FUNCTION patient_account_settled_states_why_unpaid()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."status" = 'OPEN' THEN
    NEW."no_charge_reason" := NULL;
    RETURN NEW;
  END IF;
  IF NEW."no_charge_reason" IS NULL AND NOT EXISTS (
    SELECT 1 FROM "charge_item"
     WHERE "account_id" = NEW."id" AND "status" = 'BILLED'
  ) THEN
    RAISE EXCEPTION 'patient_account_settled_states_why_unpaid: an account with nothing invoiced is settled with the reason it is not charged'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'patient_account_settled_states_why_unpaid',
            HINT = 'BI-237: set no_charge_reason.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_patient_account_settled_states_why_unpaid"
  BEFORE UPDATE OF "status" ON "patient_account"
  FOR EACH ROW
  WHEN (
    (OLD."status" = 'OPEN' AND NEW."status" = 'SETTLED')
    OR (OLD."status" <> 'OPEN' AND NEW."status" = 'OPEN')
  )
  EXECUTE FUNCTION patient_account_settled_states_why_unpaid();

-- ── 3. Cerrar la cuenta cierra la atención (EN-131, EN-139, BI-236) ───────
--
-- En la base y no en el servicio: es la misma transacción por construcción,
-- y `billing` no escribe en `encounter` (BI-156, arch:check). Sólo una
-- atención con el alta dada: la que sigue abierta o en espera no la cierra
-- caja, y una terminal no cambia. El instante es el de la cuenta, que es el
-- reloj de la aplicación; nunca `now()`.
--
-- «Cerrada» es que no queda nada, tampoco clínico (EN-131). Lo único clínico
-- que el médico aún puede hacer con el alta dada es emitir una ORDEN en
-- borrador (ORD-115) —una receta en borrador ya no se emite con el alta
-- (PR-002), así que no detiene nada—, y una atención COMPLETED ya no la
-- admite (ORD-005). Por eso: con una orden en borrador la cuenta se cierra y
-- la atención espera; cuando el último borrador sale de DRAFT —emitido o
-- descartado— y la atención tiene su cuenta liquidada y ninguna abierta, se
-- cierra con el instante y el autor de esa cuenta (D-189). El examen emitido
-- vuelve a caja igual (BI-194 lista también las COMPLETED).
CREATE FUNCTION encounter_completes_when_settled(p_encounter UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_at    TIMESTAMPTZ;
  v_by    UUID;
  v_entry UUID;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "patient_account"
     WHERE "encounter_id" = p_encounter AND "status" = 'OPEN'
  ) THEN
    RETURN;
  END IF;
  SELECT "closed_at", "changed_by" INTO v_at, v_by
    FROM "patient_account"
   WHERE "encounter_id" = p_encounter AND "status" = 'SETTLED'
   ORDER BY "closed_at" DESC
   LIMIT 1;
  -- Sin quién la cerró no hay cierre que copiar: una cuenta liquidada antes
  -- de que el cierre llevara sello (BI-215) no cierra nada (D-186).
  IF v_at IS NULL OR v_by IS NULL THEN
    RETURN;
  END IF;

  UPDATE "encounter"
     SET "status" = 'COMPLETED',
         "closed_at" = v_at,
         "closed_by_user_id" = v_by
   WHERE "id" = p_encounter
     AND "status" = 'DISCHARGED'
     AND NOT EXISTS (
       SELECT 1 FROM "service_order"
        WHERE "encounter_id" = p_encounter AND "status" = 'DRAFT'
     )
  RETURNING "agenda_entry_id" INTO v_entry;

  -- EN-139, AG-125: el paciente salió. Al que ya consta fuera no se le
  -- vuelve a sellar el instante (EN-140).
  IF v_entry IS NOT NULL THEN
    UPDATE "agenda_entry"
       SET "subject_status" = 'DEPARTED',
           "subject_status_at" = v_at
     WHERE "id" = v_entry
       AND "subject_status" IS NOT NULL
       AND "subject_status" <> 'DEPARTED';
  END IF;
END;
$$;

CREATE FUNCTION patient_account_closes_its_encounter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM encounter_completes_when_settled(NEW."encounter_id");
  RETURN NULL;
END;
$$;

CREATE TRIGGER "trg_patient_account_closes_its_encounter"
  AFTER UPDATE OF "status" ON "patient_account"
  FOR EACH ROW
  WHEN (
    OLD."status" = 'OPEN'
    AND NEW."status" = 'SETTLED'
    AND NEW."encounter_id" IS NOT NULL
  )
  EXECUTE FUNCTION patient_account_closes_its_encounter();

-- D-189: el último borrador que sale de DRAFT deja cerrar la atención cuya
-- cuenta ya se liquidó.
CREATE FUNCTION service_order_draft_resolved_closes_encounter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM encounter_completes_when_settled(NEW."encounter_id");
  RETURN NULL;
END;
$$;

CREATE TRIGGER "trg_service_order_draft_resolved_closes_encounter"
  AFTER UPDATE OF "status" ON "service_order"
  FOR EACH ROW
  WHEN (OLD."status" = 'DRAFT' AND NEW."status" <> 'DRAFT')
  EXECUTE FUNCTION service_order_draft_resolved_closes_encounter();

-- ── 4. El historial (EN-133) nombra a quien cerró la cuenta ───────────────
--
-- La misma función que `20261008055221_encounter_on_hold`, con el autor del
-- cierre leído de `closed_by_user_id` cuando lo cerró caja.
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
        -- D-184: caja closes it, as a USER; an attention closed before
        -- this delivery names its practitioner.
        v_by := NEW."closed_by_user_id";
        IF v_by IS NULL THEN
          SELECT p."user_id" INTO v_by FROM "practitioner" p WHERE p."id" = NEW."closed_by_id";
        END IF;
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
        -- Each suspension states its own reason, author and instant: one
        -- that reused the previous one's would copy them into the trail.
        IF NEW."held_at" IS NOT DISTINCT FROM OLD."held_at" THEN
          RAISE EXCEPTION
            'encounter_on_hold_states_who_when_and_why: a suspension is stamped with its own reason, author and instant'
            USING ERRCODE = 'check_violation',
                  HINT = 'EN-128: set hold_reason, held_by_id and held_at.';
        END IF;
        v_fact := 'PUT_ON_HOLD';
        v_by := NEW."held_by_id";
        v_at := NEW."held_at";
        v_reason := NEW."hold_reason";
      WHEN 'OPEN' THEN
        IF NEW."resumed_at" IS NOT DISTINCT FROM OLD."resumed_at" THEN
          RAISE EXCEPTION
            'encounter_resume_stamped: resuming is stamped with its own author and instant'
            USING ERRCODE = 'check_violation',
                  HINT = 'EN-128: set resumed_by_id and resumed_at.';
        END IF;
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
