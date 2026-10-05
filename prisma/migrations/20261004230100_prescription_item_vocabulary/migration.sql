-- PR-101, PR-102. La línea de receta guarda los CÓDIGOS con los que se
-- escribió —forma, dosis y unidad, frecuencia— junto al texto que el servidor
-- compone y congela en `presentation`, `dose_text` y `frequency_text`. Sin los
-- códigos, un borrador no se puede reabrir tal y como se escribió (PR-100).
--
-- Nullables: las líneas anteriores no los tienen y una receta emitida no se
-- toca (`prescription_item_frozen`). Que la línea nueva los lleve lo exige el
-- contrato de la API; la base exige que lo que hay sea coherente.

ALTER TABLE "prescription_item"
  ADD COLUMN "dosage_form_code" VARCHAR(32),
  ADD COLUMN "dose_amount" DECIMAL(8,2),
  ADD COLUMN "dose_unit_code" VARCHAR(32),
  ADD COLUMN "frequency_code" VARCHAR(32);

-- Una dosis es una cantidad mayor que cero, y la cantidad y su unidad van
-- juntas: «2» sin unidad no es una dosis.
ALTER TABLE "prescription_item"
  ADD CONSTRAINT "prescription_item_dose_amount_positive"
  CHECK ("dose_amount" IS NULL OR "dose_amount" > 0);

ALTER TABLE "prescription_item"
  ADD CONSTRAINT "prescription_item_dose_amount_with_unit"
  CHECK (("dose_amount" IS NULL) = ("dose_unit_code" IS NULL));
