-- BI-214 (enmienda del 10-10-2026, D-205). La copia de un cargo acreditado
-- conserva el acto clínico del original.
--
-- Hasta aquí una `CORRECTION` no podía nombrar el procedimiento ni el examen:
-- así no ocupaba los índices de BI-154, que sigue ocupando el original. Pero
-- la copia es la línea que cobra, y sin el acto el procedimiento que el médico
-- quita después ya no se señala en ella (BI-243). Ahora la nombra, la base
-- exige que sea EL MISMO acto que el del cargo que corrige, y los dos índices
-- dejan fuera a las copias: el acto ya lo ocupa su original y la copia es una
-- por cargo (`charge_item_one_correction_per_charge`).
--
-- Sin relleno: las copias ya escritas son datos de desarrollo (sin producción).

-- ── 1. El origen admite el acto en la copia ────────────────────────────────

ALTER TABLE "charge_item"
  DROP CONSTRAINT "charge_item_origin_names_its_act",
  ADD CONSTRAINT "charge_item_origin_names_its_act" CHECK (
    CASE "origin"
      WHEN 'PROCEDURE' THEN
        "encounter_procedure_id" IS NOT NULL
        AND "service_order_item_id" IS NULL
        AND "encounter_id" IS NOT NULL
        AND "corrects_charge_item_id" IS NULL
      WHEN 'EXAM' THEN
        "service_order_item_id" IS NOT NULL
        AND "encounter_procedure_id" IS NULL
        AND "encounter_id" IS NOT NULL
        AND "corrects_charge_item_id" IS NULL
      WHEN 'CONSULTATION' THEN
        "encounter_id" IS NOT NULL
        AND "encounter_procedure_id" IS NULL
        AND "service_order_item_id" IS NULL
        AND "corrects_charge_item_id" IS NULL
      WHEN 'CORRECTION' THEN
        -- El acto lo decide el cargo corregido (disparador de abajo): a lo
        -- sumo uno de los dos, como en su original.
        "corrects_charge_item_id" IS NOT NULL
        AND ("encounter_procedure_id" IS NULL OR "service_order_item_id" IS NULL)
      ELSE
        "encounter_procedure_id" IS NULL
        AND "service_order_item_id" IS NULL
        AND "corrects_charge_item_id" IS NULL
    END
  );

-- ── 2. Los índices de BI-154 son de los cargos derivados, no de sus copias ─

DROP INDEX "charge_item_one_per_encounter_procedure";
CREATE UNIQUE INDEX "charge_item_one_per_encounter_procedure"
  ON "charge_item"("encounter_procedure_id")
  WHERE "encounter_procedure_id" IS NOT NULL AND "origin" <> 'CORRECTION';

DROP INDEX "charge_item_one_per_service_order_item";
CREATE UNIQUE INDEX "charge_item_one_per_service_order_item"
  ON "charge_item"("service_order_item_id")
  WHERE "service_order_item_id" IS NOT NULL AND "origin" <> 'CORRECTION';

-- ── 3. La copia nombra el acto de su original, y ningún otro ──────────────

CREATE OR REPLACE FUNCTION charge_item_corrects_a_credited_charge()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  corrected RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM "credit_note_line" l
      JOIN "credit_note" n ON n."id" = l."credit_note_id"
     WHERE l."charge_item_id" = NEW."corrects_charge_item_id"
       AND n."reason_code" <> 'SERVICE_NOT_PROVIDED'
  ) THEN
    RAISE EXCEPTION 'charge_item_corrects_a_credited_charge: only a charge credited to be billed again comes back'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charge_item_corrects_a_credited_charge',
            HINT = 'Sólo vuelve a facturarse lo que una nota de crédito acreditó para corregirlo; «Servicio no prestado» no vuelve.';
  END IF;

  SELECT "encounter_procedure_id", "service_order_item_id"
    INTO corrected
    FROM "charge_item"
   WHERE "id" = NEW."corrects_charge_item_id";

  IF NEW."encounter_procedure_id" IS DISTINCT FROM corrected."encounter_procedure_id"
     OR NEW."service_order_item_id" IS DISTINCT FROM corrected."service_order_item_id"
  THEN
    RAISE EXCEPTION 'charge_item_corrects_a_credited_charge: the copy names the clinical act of the charge it corrects'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'charge_item_corrects_a_credited_charge',
            HINT = 'La copia de un cargo acreditado nombra el mismo procedimiento o examen que el original.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "trg_charge_item_corrects_a_credited_charge" ON "charge_item";
CREATE TRIGGER "trg_charge_item_corrects_a_credited_charge"
  BEFORE INSERT OR UPDATE OF "corrects_charge_item_id", "encounter_procedure_id", "service_order_item_id"
  ON "charge_item"
  FOR EACH ROW
  WHEN (NEW."corrects_charge_item_id" IS NOT NULL)
  EXECUTE FUNCTION charge_item_corrects_a_credited_charge();
