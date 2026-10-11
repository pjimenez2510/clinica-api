-- service_catalogue
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio. Ver scripts/new-migration.mts.
--
-- ADR-013, D-227 §1: un solo catálogo de servicios.
--
-- Lo que la clínica ofrece y cobra estaba partido en tres entidades —el tipo
-- de atención (`service_type`, con su tabla puente a la prestación), el examen
-- (`exam_definition`, atado 1:1 a una prestación) y la prestación
-- (`billable_service`, con su categoría)—. Pasa a ser UNA fila de `service`
-- con su tipo (`kind`); la consulta lleva especialidad, duración y visita; el
-- examen, la imagen y el procedimiento que se pide llevan su extensión de
-- orden (`service_exam`) y sus determinaciones (`service_exam_analyte`); el
-- procedimiento se ata por su código (D-218 §3).
--
-- SIN PRODUCCIÓN (`scripts/database-phase.mjs`, `desarrollo-datos-borrables`):
-- lo que se puede trasladar con SQL simple se traslada —la consulta toma la
-- especialidad y la duración de su tipo de atención en posición 0, la cita y
-- la espera apuntan a ese servicio, la extensión copia el examen— y lo demás
-- se pierde a propósito (un tipo de atención sin prestación deja su cita sin
-- servicio; una «consulta» sin tipo pasa a «otro»).

-- ── 1. La tabla se llama `service` ──────────────────────────────────────
ALTER TABLE "billable_service" RENAME TO "service";
ALTER TABLE "service" RENAME COLUMN "tariff_code" TO "msp_code";

ALTER TABLE "service" RENAME CONSTRAINT "billable_service_pkey" TO "service_pkey";
ALTER TABLE "service" RENAME CONSTRAINT "billable_service_code_unique" TO "service_code_unique";
ALTER TABLE "service" RENAME CONSTRAINT "billable_service_tax_rate_fk" TO "service_tax_rate_fk";
ALTER TABLE "service" RENAME CONSTRAINT "billable_service_tax_reviewer_fk" TO "service_tax_reviewer_fk";
ALTER TABLE "service" RENAME CONSTRAINT "billable_service_tax_review_names_who_and_when" TO "service_tax_review_names_who_and_when";
ALTER TABLE "service" RENAME CONSTRAINT "billable_service_written_consent_setter_fk" TO "service_written_consent_setter_fk";
ALTER TABLE "service" RENAME CONSTRAINT "billable_service_written_consent_states_who" TO "service_written_consent_states_who";

ALTER TABLE "price" RENAME COLUMN "billable_service_id" TO "service_id";
ALTER TABLE "charge_item" RENAME COLUMN "billable_service_id" TO "service_id";
ALTER TABLE "tariff_publication_item" RENAME COLUMN "billable_service_id" TO "service_id";

-- Los disparadores de `charge_item` comparan la fila entera por nombre de
-- columna: se recrean con `service_id`.
CREATE OR REPLACE FUNCTION charge_item_billed_is_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'BILLED'
     AND (OLD."account_id", OLD."service_id", OLD."encounter_id",
          OLD."service_date", OLD."quantity", OLD."unit_amount",
          OLD."resolved_price_id", OLD."service_display", OLD."tax_sri_code",
          OLD."tax_percentage", OLD."discount_amount", OLD."discount_reason",
          OLD."discount_applied_by_id", OLD."discount_applied_at",
          OLD."discount_authorised_by_id", OLD."discount_authorised_at",
          OLD."status", OLD."invoice_id")
         IS DISTINCT FROM
         (NEW."account_id", NEW."service_id", NEW."encounter_id",
          NEW."service_date", NEW."quantity", NEW."unit_amount",
          NEW."resolved_price_id", NEW."service_display", NEW."tax_sri_code",
          NEW."tax_percentage", NEW."discount_amount", NEW."discount_reason",
          NEW."discount_applied_by_id", NEW."discount_applied_at",
          NEW."discount_authorised_by_id", NEW."discount_authorised_at",
          NEW."status", NEW."invoice_id") THEN
    RAISE EXCEPTION 'charge_item_billed_is_frozen: a billed charge is corrected with a credit note'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charge_item_billed_is_frozen',
            HINT = 'Un cargo facturado no se edita: se corrige la factura (BI-056).';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION charge_item_discount_is_permanent()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
       -- Lo que dice el descuento sólo cambia con un acto nuevo...
       NEW."discount_applied_at" IS NOT DISTINCT FROM OLD."discount_applied_at"
       AND (OLD."discount_amount", OLD."discount_reason", OLD."discount_applied_by_id",
            OLD."discount_authorised_by_id", OLD."discount_authorised_at")
           IS DISTINCT FROM
           (NEW."discount_amount", NEW."discount_reason", NEW."discount_applied_by_id",
            NEW."discount_authorised_by_id", NEW."discount_authorised_at")
     )
     -- ...y ese acto va después del que reemplaza.
     OR (OLD."discount_applied_at" IS NOT NULL
         AND NEW."discount_applied_at" IS NOT NULL
         AND NEW."discount_applied_at" <= OLD."discount_applied_at"
         AND NEW."discount_applied_at" IS DISTINCT FROM OLD."discount_applied_at")
     -- BI-244. La línea con descuento no se mueve, haya acto nuevo o no.
     OR (OLD."discount_amount" > 0
         AND (OLD."quantity", OLD."unit_amount", OLD."service_id",
              OLD."service_date", OLD."resolved_price_id", OLD."tax_sri_code",
              OLD."tax_percentage")
             IS DISTINCT FROM
             (NEW."quantity", NEW."unit_amount", NEW."service_id",
              NEW."service_date", NEW."resolved_price_id", NEW."tax_sri_code",
              NEW."tax_percentage"))
  THEN
    RAISE EXCEPTION 'charge_item_discount_is_permanent: a discount is removed or replaced, never edited, and its line keeps its amount'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charge_item_discount_is_permanent',
            HINT = 'Quite el descuento antes de cambiar la cantidad, el servicio, la fecha o el precio (BI-244).';
  END IF;
  RETURN NEW;
END;
$$;

-- ── 2. El tipo sustituye a la categoría (BI-278) ─────────────────────────
ALTER TABLE "service"
  ADD COLUMN "kind" VARCHAR(16),
  ADD COLUMN "specialty_id" UUID,
  ADD COLUMN "duration_minutes" SMALLINT,
  ADD COLUMN "visit_kind" VARCHAR(16);

UPDATE "service" s
   SET "kind" = CASE c."kind" WHEN 'LABORATORY' THEN 'LAB_EXAM' ELSE c."kind" END
  FROM "billable_service_category" c
 WHERE c."id" = s."category_id";

-- La consulta toma especialidad, duración y visita de su tipo de atención
-- (la prestación en posición 0, SP-031). Si una prestación era la primera de
-- dos tipos, gana el de menor id: su otra cita apuntará igual a ella (§4).
UPDATE "service" s
   SET "specialty_id"     = t."specialty_id",
       "duration_minutes" = t."duration_minutes",
       "visit_kind"       = CASE immutable_unaccent(lower(btrim(t."name")))
                              WHEN 'primera vez' THEN 'FIRST_VISIT'
                              WHEN 'control'     THEN 'FOLLOW_UP'
                              WHEN 'subsecuente' THEN 'FOLLOW_UP'
                            END
  FROM (
    SELECT DISTINCT ON (x."billable_service_id")
           x."billable_service_id" AS service_id, st."specialty_id",
           st."duration_minutes", st."name"
      FROM "service_type_billable_service" x
      JOIN "service_type" st ON st."id" = x."service_type_id"
     WHERE x."position" = 0
     ORDER BY x."billable_service_id", st."id"
  ) t
 WHERE t.service_id = s."id"
   AND s."kind" = 'CONSULTATION';

-- Una «consulta» que ningún tipo de atención cobraba no tiene especialidad ni
-- duración: pasa a «otro», que se sigue pudiendo cobrar a mano.
UPDATE "service" SET "kind" = 'OTHER'
 WHERE "kind" = 'CONSULTATION' AND "specialty_id" IS NULL;

-- Dos servicios activos con el mismo nombre se distinguen por su código antes
-- de exigir la unicidad.
UPDATE "service" s
   SET "name" = left(s."name" || ' (' || s."code" || ')', 200)
  FROM (
    SELECT "id",
           row_number() OVER (PARTITION BY immutable_unaccent(lower(btrim("name")))
                              ORDER BY "created_at", "id") AS n
      FROM "service" WHERE "active"
  ) d
 WHERE d."id" = s."id" AND d.n > 1;

ALTER TABLE "service" ALTER COLUMN "kind" SET NOT NULL;

ALTER TABLE "service"
  ADD CONSTRAINT "service_kind_is_known" CHECK ("kind" IN
    ('CONSULTATION', 'PROCEDURE', 'LAB_EXAM', 'IMAGING', 'SUPPLY', 'OTHER')),
  ADD CONSTRAINT "service_name_not_blank" CHECK (btrim("name") <> ''),
  ADD CONSTRAINT "service_specialty_fk" FOREIGN KEY ("specialty_id")
    REFERENCES "specialty"("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
  -- BI-279. La consulta lleva los tres datos de la agenda; nada más los lleva.
  ADD CONSTRAINT "service_consultation_shape" CHECK (
    CASE WHEN "kind" = 'CONSULTATION'
         THEN "specialty_id" IS NOT NULL AND "duration_minutes" IS NOT NULL
         ELSE "specialty_id" IS NULL AND "duration_minutes" IS NULL
              AND "visit_kind" IS NULL
    END),
  -- El mismo `CHECK` que tenía `service_type_duration_range` (SP-021): el
  -- átomo de cada sede lo valida la aplicación al guardar.
  ADD CONSTRAINT "service_duration_range" CHECK ("duration_minutes" IS NULL OR
    ("duration_minutes" BETWEEN 5 AND 240 AND "duration_minutes" % 5 = 0)),
  ADD CONSTRAINT "service_visit_kind_is_known" CHECK ("visit_kind" IS NULL OR
    "visit_kind" IN ('FIRST_VISIT', 'FOLLOW_UP'));

-- BI-278. Sin tildes ni mayúsculas, sólo entre activos: un servicio retirado
-- no impide volver a crear otro con su nombre.
CREATE UNIQUE INDEX "service_active_name_unique"
  ON "service"(immutable_unaccent(lower(btrim("name"))))
  WHERE "active";

DROP INDEX "billable_service_by_category";
CREATE INDEX "service_by_kind" ON "service"("kind", "name");
CREATE INDEX "service_by_specialty" ON "service"("specialty_id")
  WHERE "specialty_id" IS NOT NULL;

-- BI-278. El tipo no cambia tras el alta: decide qué estructura tiene la fila
-- y qué la referencia (una cita, una orden, un procedimiento).
CREATE OR REPLACE FUNCTION service_kind_is_fixed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind" THEN
    RAISE EXCEPTION 'service_kind_is_fixed: the kind of a service does not change once created'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'service_kind_is_fixed',
            HINT = 'BI-278.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_service_kind_is_fixed"
  BEFORE UPDATE OF "kind" ON "service"
  FOR EACH ROW EXECUTE FUNCTION service_kind_is_fixed();

-- ── 3. La extensión de orden (BI-284) ────────────────────────────────────
CREATE TABLE "service_exam" (
  "service_id"           UUID         NOT NULL,
  "form_010_section"     VARCHAR(60),
  "specimen_type"        VARCHAR(80),
  "patient_preparation"  VARCHAR(500),
  "turnaround_hours"     SMALLINT,
  "requires_fasting"     BOOLEAN      NOT NULL DEFAULT false,
  "fasting_hours"        SMALLINT,
  "performed_externally" BOOLEAN      NOT NULL DEFAULT true,
  "external_lab_name"    VARCHAR(160),
  "external_lab_code"    VARCHAR(64),
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "service_exam_pkey" PRIMARY KEY ("service_id"),
  CONSTRAINT "service_exam_service_fk" FOREIGN KEY ("service_id")
    REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "service_exam_fasting_hours_needs_fasting"
    CHECK ("fasting_hours" IS NULL OR "requires_fasting"),
  CONSTRAINT "service_exam_fasting_hours_range"
    CHECK ("fasting_hours" IS NULL OR "fasting_hours" BETWEEN 1 AND 24)
);

INSERT INTO "service_exam"
  ("service_id", "form_010_section", "specimen_type", "patient_preparation",
   "turnaround_hours", "requires_fasting", "fasting_hours",
   "performed_externally", "external_lab_name", "external_lab_code",
   "created_at", "updated_at")
SELECT e."billable_service_id", e."form_010_section", e."specimen_type",
       e."patient_preparation", e."turnaround_hours", e."requires_fasting",
       e."fasting_hours", e."performed_externally", e."external_lab_name",
       e."external_lab_code", e."created_at", e."updated_at"
  FROM "exam_definition" e;

-- Un examen desactivado deja de pedirse: su servicio, también.
UPDATE "service" s SET "active" = false
  FROM "exam_definition" e
 WHERE e."billable_service_id" = s."id" AND NOT e."active" AND s."active";

-- La extensión sólo en lo que se pide en una orden.
CREATE OR REPLACE FUNCTION service_exam_kind_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "service"
                  WHERE "id" = NEW."service_id"
                    AND "kind" IN ('LAB_EXAM', 'IMAGING', 'PROCEDURE')) THEN
    RAISE EXCEPTION 'service_exam_kind_admits: only an exam, an imaging study or a procedure is ordered'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'service_exam_kind_admits',
            HINT = 'BI-284.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_service_exam_kind_admits"
  BEFORE INSERT OR UPDATE OF "service_id" ON "service_exam"
  FOR EACH ROW EXECUTE FUNCTION service_exam_kind_admits();

CREATE TABLE "service_exam_analyte" (
  "service_id"            UUID     NOT NULL,
  "analyte_definition_id" UUID     NOT NULL,
  "position"              SMALLINT NOT NULL,
  "is_reflex"             BOOLEAN  NOT NULL DEFAULT false,
  CONSTRAINT "service_exam_analyte_pkey" PRIMARY KEY ("service_id", "analyte_definition_id"),
  -- CASCADE, como la extensión: es la estructura del servicio, no un registro
  -- clínico, y un servicio sólo se borra si nada lo nombra (BI-288); lo pedido
  -- y lo informado congelan su código y sus valores (ORD-002, ORD-110).
  CONSTRAINT "service_exam_analyte_exam_fk" FOREIGN KEY ("service_id")
    REFERENCES "service_exam"("service_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "service_exam_analyte_analyte_fk" FOREIGN KEY ("analyte_definition_id")
    REFERENCES "analyte_definition"("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

INSERT INTO "service_exam_analyte"
  ("service_id", "analyte_definition_id", "position", "is_reflex")
SELECT e."billable_service_id", a."analyte_definition_id", a."position", a."is_reflex"
  FROM "exam_definition_analyte" a
  JOIN "exam_definition" e ON e."id" = a."exam_definition_id";

-- La línea de una orden congela el código del SERVICIO (ORD-002, BI-284): las
-- ya emitidas con el código propio del examen (`EX-…`) pasan al del servicio.
-- Es la única escritura sobre líneas emitidas, y por eso se apaga su guarda
-- sólo durante ella.
ALTER TABLE "service_order_item" DISABLE TRIGGER "service_order_item_guard_frozen";
UPDATE "service_order_item" i
   SET "test_code" = s."code"
  FROM "exam_definition" e
  JOIN "service" s ON s."id" = e."billable_service_id"
 WHERE i."test_code" = e."code" AND e."code" <> s."code";
ALTER TABLE "service_order_item" ENABLE TRIGGER "service_order_item_guard_frozen";

-- ORD-004 (D-218 §1): el código MSP ya no es requisito para pedir, así que la
-- línea puede no tener concepto del tarifario.
ALTER TABLE "service_order_item" ALTER COLUMN "concept_id" DROP NOT NULL;

-- BI-281, ORD-140. El código de un servicio ya pedido no cambia.
CREATE OR REPLACE FUNCTION service_code_fixed_once_ordered()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."code" IS DISTINCT FROM OLD."code"
     AND EXISTS (SELECT 1 FROM "service_order_item" WHERE "test_code" = OLD."code") THEN
    RAISE EXCEPTION 'service_code_in_use: an order line already froze this code'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'service_code_in_use',
            HINT = 'El código de un servicio ya pedido no cambia (ORD-140, BI-281).';
  END IF;
  -- BI-281. Ni el de uno facturado: la representación impresa lo vuelve a leer.
  IF NEW."code" IS DISTINCT FROM OLD."code"
     AND EXISTS (SELECT 1 FROM "charge_item"
                  WHERE "service_id" = NEW."id" AND "invoice_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'service_code_invoiced: an invoice already printed this code'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'service_code_invoiced',
            HINT = 'BI-281.';
  END IF;
  -- BI-285. El código MSP sale en el RIDE como «Cód. auxiliar».
  IF NEW."msp_code" IS DISTINCT FROM OLD."msp_code"
     AND EXISTS (SELECT 1 FROM "charge_item"
                  WHERE "service_id" = NEW."id" AND "invoice_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'service_msp_code_invoiced: an invoice already printed this MSP code'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'service_msp_code_invoiced',
            HINT = 'BI-285.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_service_code_fixed_once_ordered"
  BEFORE UPDATE OF "code", "msp_code" ON "service"
  FOR EACH ROW EXECUTE FUNCTION service_code_fixed_once_ordered();

-- ── 4. La cita, la espera y la excepción apuntan al servicio ─────────────
CREATE TEMP TABLE "service_of_type" ON COMMIT DROP AS
SELECT x."service_type_id", x."billable_service_id" AS service_id
  FROM "service_type_billable_service" x
  JOIN "service" s ON s."id" = x."billable_service_id" AND s."kind" = 'CONSULTATION'
 WHERE x."position" = 0;

-- El disparador de versiones nombra la columna vieja en su condición: se
-- quita, se traslada y se vuelve a crear con la nueva. Trasladar no es editar
-- la cita, y no deja versión.
DROP TRIGGER "trg_agenda_entry_record_version" ON "agenda_entry";
ALTER TABLE "agenda_entry" DISABLE TRIGGER "trg_agenda_entry_emergency_immutable";

ALTER TABLE "agenda_entry" ADD COLUMN "service_id" UUID;
UPDATE "agenda_entry" a SET "service_id" = m.service_id
  FROM "service_of_type" m WHERE m."service_type_id" = a."service_type_id";
ALTER TABLE "agenda_entry" DROP COLUMN "service_type_id";
ALTER TABLE "agenda_entry"
  ADD CONSTRAINT "agenda_entry_service_fk" FOREIGN KEY ("service_id")
    REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
-- SP-025, BI-288: borrar un servicio decide si alguna cita lo nombra.
CREATE INDEX "agenda_entry_by_service" ON "agenda_entry"("service_id")
  WHERE "service_id" IS NOT NULL;

ALTER TABLE "agenda_entry" ENABLE TRIGGER "trg_agenda_entry_emergency_immutable";

CREATE TRIGGER "trg_agenda_entry_record_version"
  BEFORE UPDATE ON "agenda_entry"
  FOR EACH ROW
  WHEN (
       OLD."starts_at" IS DISTINCT FROM NEW."starts_at"
    OR OLD."ends_at" IS DISTINCT FROM NEW."ends_at"
    OR OLD."practitioner_id" IS DISTINCT FROM NEW."practitioner_id"
    OR OLD."room_id" IS DISTINCT FROM NEW."room_id"
    OR OLD."service_id" IS DISTINCT FROM NEW."service_id"
    OR OLD."reason" IS DISTINCT FROM NEW."reason"
    OR OLD."booking_channel" IS DISTINCT FROM NEW."booking_channel"
    OR OLD."patient_id" IS DISTINCT FROM NEW."patient_id"
    OR OLD."blocks_calendar" IS DISTINCT FROM NEW."blocks_calendar"
    OR OLD."overbooking_authorised_by_id" IS DISTINCT FROM NEW."overbooking_authorised_by_id"
    OR OLD."overbooking_reason" IS DISTINCT FROM NEW."overbooking_reason"
    OR (OLD."emergency_assessed_at" IS NOT NULL AND (
          OLD."emergency_assessed_at" IS DISTINCT FROM NEW."emergency_assessed_at"
       OR OLD."emergency_assessed_by_id" IS DISTINCT FROM NEW."emergency_assessed_by_id"
       OR OLD."emergency_flagged_at" IS DISTINCT FROM NEW."emergency_flagged_at"
       OR OLD."emergency_flagged_by_id" IS DISTINCT FROM NEW."emergency_flagged_by_id"
       OR OLD."emergency_note" IS DISTINCT FROM NEW."emergency_note"))
  )
  EXECUTE FUNCTION record_version_archive('edited_by_id', 'edited_at', 'id');

ALTER TABLE "waitlist_entry" DISABLE TRIGGER "trg_waitlist_entry_closure_final";
ALTER TABLE "waitlist_entry" DISABLE TRIGGER "trg_waitlist_entry_conversion_consented";
ALTER TABLE "waitlist_entry" ADD COLUMN "service_id" UUID;
UPDATE "waitlist_entry" w SET "service_id" = m.service_id
  FROM "service_of_type" m WHERE m."service_type_id" = w."service_type_id";
ALTER TABLE "waitlist_entry" DROP COLUMN "service_type_id";
ALTER TABLE "waitlist_entry"
  ADD CONSTRAINT "waitlist_entry_service_fk" FOREIGN KEY ("service_id")
    REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
-- AG-060, BI-288: el gemelo de `agenda_entry_by_service`.
CREATE INDEX "waitlist_entry_by_service" ON "waitlist_entry"("service_id")
  WHERE "service_id" IS NOT NULL;
ALTER TABLE "waitlist_entry" ENABLE TRIGGER "trg_waitlist_entry_closure_final";
ALTER TABLE "waitlist_entry" ENABLE TRIGGER "trg_waitlist_entry_conversion_consented";

-- SP-022. La excepción de duración, por médico y servicio de consulta. La que
-- se refería a un tipo sin servicio se pierde con él.
ALTER TABLE "duration_exception" ADD COLUMN "service_id" UUID;
UPDATE "duration_exception" d SET "service_id" = m.service_id
  FROM "service_of_type" m WHERE m."service_type_id" = d."service_type_id";
DELETE FROM "duration_exception" WHERE "service_id" IS NULL;
-- Dos tipos que apuntaban al mismo servicio: queda una excepción por médico.
DELETE FROM "duration_exception" d
 USING "duration_exception" o
 WHERE o."practitioner_id" = d."practitioner_id"
   AND o."service_id" = d."service_id"
   AND o."service_type_id" < d."service_type_id";
ALTER TABLE "duration_exception" DROP CONSTRAINT "duration_exception_pkey";
ALTER TABLE "duration_exception" DROP COLUMN "service_type_id";
ALTER TABLE "duration_exception" ALTER COLUMN "service_id" SET NOT NULL;
ALTER TABLE "duration_exception"
  ADD CONSTRAINT "duration_exception_pkey" PRIMARY KEY ("practitioner_id", "service_id"),
  ADD CONSTRAINT "duration_exception_service_fk" FOREIGN KEY ("service_id")
    REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ── 5. El procedimiento, por su código (BI-286, D-218 §3) ────────────────
DROP TRIGGER "billable_service_procedure_tie_admits" ON "service";
DROP TRIGGER "billable_service_tariff_code_is_its_procedure" ON "service";
DROP TRIGGER "billable_service_written_consent_tie_locked" ON "service";
DROP FUNCTION billable_service_procedure_tie_admits();
DROP FUNCTION billable_service_tariff_code_is_its_procedure();
DROP FUNCTION billable_service_written_consent_tie_locked();
DROP INDEX "billable_service_one_per_procedure";
ALTER TABLE "service" DROP CONSTRAINT "billable_service_written_consent_needs_a_procedure";

-- El código MSP de un procedimiento ya era el de su concepto
-- (`billable_service_tariff_code_is_its_procedure`); el concepto sobra.
ALTER TABLE "service" DROP COLUMN "procedure_concept_id";

-- Una «prestación» de procedimiento sólo cobra un procedimiento registrado si
-- su código coincide: dos con el mismo código harían que caja propusiera una
-- en silencio.
CREATE UNIQUE INDEX "service_one_procedure_per_code"
  ON "service"("msp_code")
  WHERE "kind" = 'PROCEDURE' AND "active" AND "msp_code" IS NOT NULL;

ALTER TABLE "service"
  ADD CONSTRAINT "service_written_consent_needs_a_procedure" CHECK (
    NOT "requires_written_consent" OR ("kind" = 'PROCEDURE' AND "msp_code" IS NOT NULL));

-- BI-256 (D-199.1). Lo que exige el 024 no cambia de código ni se borra
-- mientras esté marcado: primero se desmarca.
CREATE OR REPLACE FUNCTION service_written_consent_code_locked()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."requires_written_consent"
     AND (TG_OP = 'DELETE'
          OR (NEW."requires_written_consent"
              AND NEW."msp_code" IS DISTINCT FROM OLD."msp_code")) THEN
    RAISE EXCEPTION
      'service_written_consent_code_locked: a service that demands the form 024 keeps its procedure code; unmark it first'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'BI-256, D-199.1.';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "trg_service_written_consent_code_locked"
  BEFORE UPDATE OF "msp_code" OR DELETE ON "service"
  FOR EACH ROW EXECUTE FUNCTION service_written_consent_code_locked();

-- EN-152. Un procedimiento del tarifario exige el 024 si un servicio de
-- procedimiento marcado lleva su código, de la edición que sea.
CREATE OR REPLACE FUNCTION procedure_requires_written_consent(p_concept_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM catalog_concept target
      JOIN catalog_system cs ON cs.id = target.system_id AND cs.code = 'TARIFF'
      JOIN service s ON s.kind = 'PROCEDURE' AND s.msp_code = target.code
     WHERE target.id = p_concept_id
       AND s.requires_written_consent
  );
$$;

-- ── 6. El importe que nadie leía (EN-051, D-218 §3) ──────────────────────
CREATE OR REPLACE FUNCTION encounter_procedure_retraction_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  live encounter_procedure%ROWTYPE;
BEGIN
  SELECT * INTO live FROM encounter_procedure WHERE id = NEW.id;
  IF NOT FOUND
     OR live.encounter_id IS DISTINCT FROM NEW.encounter_id
     OR live.concept_id IS DISTINCT FROM NEW.concept_id
     OR live.procedure_code IS DISTINCT FROM NEW.procedure_code
     OR live.procedure_display IS DISTINCT FROM NEW.procedure_display
     OR live.quantity IS DISTINCT FROM NEW.quantity
     OR live.performed_at IS DISTINCT FROM NEW.performed_at
     OR live.note IS DISTINCT FROM NEW.note
     OR live.edited_by_id IS DISTINCT FROM NEW.edited_by_id
     OR live.edited_at IS DISTINCT FROM NEW.edited_at
     OR live.recorded_at IS DISTINCT FROM NEW.recorded_at
     OR live.recorded_by_id IS DISTINCT FROM NEW.recorded_by_id THEN
    RAISE EXCEPTION
      'encounter_procedure_retraction_matches: the archive must be the procedure being removed, as it is'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-245.';
  END IF;

  IF NEW.restored_at IS NOT NULL OR NEW.restored_by_id IS NOT NULL
     OR NEW.restored_as_id IS NOT NULL THEN
    RAISE EXCEPTION
      'encounter_procedure_retraction_frozen: an archive is born not restored'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-246.';
  END IF;

  RETURN NEW;
END;
$$;

ALTER TABLE "encounter_procedure" DROP COLUMN "tariff_amount";
ALTER TABLE "encounter_procedure_retraction" DROP COLUMN "tariff_amount";

-- ── 7. Lo que se elimina ─────────────────────────────────────────────────
DROP TRIGGER "exam_definition_service_not_tied" ON "exam_definition";
DROP TRIGGER "trg_exam_definition_code_fixed_once_ordered" ON "exam_definition";
DROP FUNCTION exam_definition_service_not_tied();
DROP FUNCTION exam_definition_code_fixed_once_ordered();
DROP TABLE "exam_definition_analyte";
DROP TABLE "exam_definition";
DROP TABLE "service_type_billable_service";
DROP TABLE "service_type";

ALTER TABLE "service" DROP CONSTRAINT "billable_service_category_fk";
ALTER TABLE "service" DROP COLUMN "category_id";
DROP TABLE "billable_service_category";

-- ── 8. La bitácora admite los recursos nuevos (BI-290) ───────────────────
-- Los nombres viejos siguen admitidos: las filas ya escritas los llevan.
ALTER TABLE "access_audit" DROP CONSTRAINT "access_audit_payload_only_for_declared_resources";
ALTER TABLE "access_audit" ADD CONSTRAINT "access_audit_payload_only_for_declared_resources"
  CHECK (("before" IS NULL AND "after" IS NULL) OR "resource_type" IN (
    'configuration', 'staff', 'organization', 'auth',
    'billable_service', 'billable_service_category', 'price', 'payer',
    'exam_definition', 'analyte_definition', 'payment_method',
    'role_discount_limit', 'service', 'service_exam'));

COMMENT ON TABLE "service" IS
  'ADR-013. Una fila por cosa que la clínica ofrece y cobra; su tipo (kind) dice qué estructura admite.';
COMMENT ON TABLE "service_exam" IS
  'BI-284. La extensión de orden de un examen, una imagen o un procedimiento que se pide.';
