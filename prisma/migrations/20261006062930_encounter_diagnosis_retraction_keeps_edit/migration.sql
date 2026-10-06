-- encounter_diagnosis_retraction_keeps_edit
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-212, EN-180: EL ARCHIVO DE LOS QUITADOS GUARDA TAMBIÉN LA ÚLTIMA EDICIÓN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El motivo de una edición se guarda en la fila que esa edición dejó
-- (`edit_reason`, EN-212), y la lectura de versiones lo devuelve junto a la
-- versión sustituida. Al quitar el diagnóstico, la fila viva pasaba al
-- archivo SIN `edit_reason`, `edited_by_id` ni `edited_at`, y se borraba: el
-- motivo de cambiar un código que un certificado imprimió (J00 → J06,
-- «Código mal elegido») desaparecía con ella. Justo el motivo que existe
-- porque un tercero tiene un papel que dice otra cosa.
--
-- 1. Las tres columnas en el archivo, con las mismas reglas que en la tabla
--    viva: quién y cuándo juntos o ninguno, y un motivo no vacío.
-- 2. `encounter_diagnosis_retraction_matches` las compara también: el archivo
--    es la fila que se quita TAL COMO ES, y un archivo sin el sello de la
--    última edición no lo es.
--
-- LOS ARCHIVOS QUE YA EXISTEN quedan con las tres vacías. No se rellenan: el
-- estado de la fila en el momento de quitarla no está en ninguna otra parte
-- (`record_version` guarda las versiones ANTERIORES a cada edición, no la
-- última), y vacío dice la verdad —«no se sabe»—. `ADD COLUMN` sin defecto no
-- ejecuta un UPDATE ni dispara `encounter_diagnosis_retraction_frozen`.

ALTER TABLE "encounter_diagnosis_retraction"
  ADD COLUMN "edited_by_id" UUID,
  ADD COLUMN "edited_at" TIMESTAMPTZ(6),
  ADD COLUMN "edit_reason" VARCHAR(500);

ALTER TABLE "encounter_diagnosis_retraction"
  ADD CONSTRAINT "encounter_diagnosis_retraction_edited_by_id_fkey"
  FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "encounter_diagnosis_retraction"
  ADD CONSTRAINT "encounter_diagnosis_retraction_edit_stamped" CHECK (
    ("edited_by_id" IS NULL) = ("edited_at" IS NULL)
  );

ALTER TABLE "encounter_diagnosis_retraction"
  ADD CONSTRAINT "encounter_diagnosis_retraction_edit_reason_not_blank"
  CHECK ("edit_reason" IS NULL OR btrim("edit_reason") <> '');

-- La función de `20261005070200_service_order_frozen_diagnoses`, con las tres
-- columnas de la edición en la comparación. El resto, igual.
CREATE OR REPLACE FUNCTION encounter_diagnosis_retraction_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  live encounter_diagnosis%ROWTYPE;
BEGIN
  SELECT * INTO live FROM encounter_diagnosis WHERE id = NEW.id;
  IF NOT FOUND
     OR live.encounter_id IS DISTINCT FROM NEW.encounter_id
     OR live.concept_id IS DISTINCT FROM NEW.concept_id
     OR live.cie10_code IS DISTINCT FROM NEW.cie10_code
     OR live.cie10_display IS DISTINCT FROM NEW.cie10_display
     OR live.certainty IS DISTINCT FROM NEW.certainty
     OR live.occurrence IS DISTINCT FROM NEW.occurrence
     OR live.rank IS DISTINCT FROM NEW.rank
     OR live.notifiable IS DISTINCT FROM NEW.notifiable
     OR live.note IS DISTINCT FROM NEW.note
     OR live.recorded_at IS DISTINCT FROM NEW.recorded_at
     OR live.edited_by_id IS DISTINCT FROM NEW.edited_by_id
     OR live.edited_at IS DISTINCT FROM NEW.edited_at
     OR live.edit_reason IS DISTINCT FROM NEW.edit_reason THEN
    RAISE EXCEPTION
      'encounter_diagnosis_retraction_matches: the archive must be the diagnosis being removed, as it is'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-180, EN-212.';
  END IF;

  IF NEW.restored_at IS NOT NULL OR NEW.restored_by_id IS NOT NULL
     OR NEW.restored_as_id IS NOT NULL THEN
    RAISE EXCEPTION
      'encounter_diagnosis_retraction_frozen: an archive is born not restored'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-213.';
  END IF;

  IF encounter_is_reported(NEW.encounter_id) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_reported: the attention was already reported to the RDACAA, and a correction would not reach it'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-213, D-117.16.';
  END IF;

  IF cie10_is_obstetric(NEW.cie10_code)
     AND encounter_diagnosis_supports_maternity_rest(NEW.encounter_id, NEW.id) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_supports_maternity_rest: a maternity rest in force stands on this obstetric diagnosis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-213, D-117.15. Annul the rest first.';
  END IF;

  IF NEW.reason IS NULL
     AND encounter_diagnosis_retraction_needs_reason(NEW.encounter_id, NEW.cie10_code) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_retraction_reason: an issued certificate, receta or order printed this code, so removing it states why'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-214, EN-189, D-117.14, ORD-121.';
  END IF;

  IF encounter_has_discharge(NEW.encounter_id)
     AND (SELECT count(*) FROM encounter_diagnosis d
           WHERE d.encounter_id = NEW.encounter_id) <= 1 THEN
    RAISE EXCEPTION
      'encounter_diagnosis_last_after_discharge: a discharged attention keeps at least one diagnosis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-188.';
  END IF;

  RETURN NEW;
END;
$$;
