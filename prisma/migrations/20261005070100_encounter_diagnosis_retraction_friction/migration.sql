-- encounter_diagnosis_retraction_friction
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-213, EN-214 (D-126): QUITAR UN DIAGNÓSTICO CON LA FRICCIÓN JUSTA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. EL MOTIVO, SÓLO CON UN PAPEL EN MANOS DE UN TERCERO (D-126.3). Hasta
--    aquí `encounter_diagnosis_retraction_needs_reason` lo exigía también con
--    una nota firmada (EN-181) o con el alta (EN-188). Eso pasa a ser una
--    confirmación en la pantalla (D-126.2): el rastro —quién, cuándo, la fila
--    entera— lo guarda el archivo igual. Sigue exigiéndolo el certificado
--    emitido que imprimió el código (EN-189) y, nuevo, la receta emitida que
--    lo imprimió (D-117.14): la farmacia tiene un papel que dice otra cosa.
--    Es la misma función que EN-212 usa al cambiar el código.
--
-- 2. LO QUE SE RECHAZA AL QUITAR, como al editar (EN-212):
--    · una atención ya reportada al RDACAA (D-117.16);
--    · el último diagnóstico obstétrico de un reposo de maternidad no anulado
--      de la atención (D-117.15): la salida es anular el reposo.
--    Sigue: el último tras el alta (EN-188 G1) y la orden con exámenes vivos
--    (EN-182, hasta ORD-121).
--
-- 3. «DESHACER» (EN-213). Quitar antes de firmar es un clic con «Deshacer».
--    El archivo no se toca para deshacer: el diagnóstico vuelve como una fila
--    NUEVA de `encounter_diagnosis` (otro id: el del archivo ya está usado y un
--    segundo «quitar» lo necesitaría), y el archivo dice, UNA vez, quién lo
--    recuperó, cuándo y como qué fila (`restored_*`). Nada más del archivo
--    cambia, ni se borra, ni se desmarca.
--
-- NO SE TOCA NINGUNA FILA GUARDADA: los archivos que existan quedan con
-- `restored_*` vacíos, que es la verdad («nadie los recuperó»).

-- ── 1. El motivo ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION encounter_diagnosis_retraction_needs_reason(
  p_encounter_id uuid,
  p_cie10_code   text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT encounter_diagnosis_code_on_paper(p_encounter_id, p_cie10_code);
$$;

-- ── 2. Lo que el archivo admite ──────────────────────────────────────────
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
     OR live.recorded_at IS DISTINCT FROM NEW.recorded_at THEN
    RAISE EXCEPTION
      'encounter_diagnosis_retraction_matches: the archive must be the diagnosis being removed, as it is'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-180.';
  END IF;

  -- Nacer recuperado no es nacer: el «deshacer» se escribe después.
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
      'encounter_diagnosis_retraction_reason: an issued certificate or receta printed this code, so removing it states why'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-214, EN-189, D-117.14.';
  END IF;

  IF encounter_has_discharge(NEW.encounter_id)
     AND (SELECT count(*) FROM encounter_diagnosis d
           WHERE d.encounter_id = NEW.encounter_id) <= 1 THEN
    RAISE EXCEPTION
      'encounter_diagnosis_last_after_discharge: a discharged attention keeps at least one diagnosis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-188.';
  END IF;

  IF encounter_has_document_citing_diagnoses(NEW.encounter_id) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_cited: an issued order with exams not cancelled reads these diagnoses'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-182. Cancel the exams first.';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 3. Deshacer ───────────────────────────────────────────────────────────
ALTER TABLE "encounter_diagnosis_retraction"
  ADD COLUMN "restored_at" TIMESTAMPTZ(6),
  ADD COLUMN "restored_by_id" UUID,
  ADD COLUMN "restored_as_id" UUID;

ALTER TABLE "encounter_diagnosis_retraction"
  ADD CONSTRAINT "encounter_diagnosis_retraction_restored_by_id_fkey"
  FOREIGN KEY ("restored_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Quién, cuándo y como qué fila: los tres o ninguno.
ALTER TABLE "encounter_diagnosis_retraction"
  ADD CONSTRAINT "encounter_diagnosis_retraction_restored_states_who_when_what" CHECK (
    ("restored_at" IS NULL) = ("restored_by_id" IS NULL)
    AND ("restored_at" IS NULL) = ("restored_as_id" IS NULL)
  );

-- `restored_as_id` NO es clave foránea: el diagnóstico recuperado se puede
-- volver a quitar (y entonces se archiva y se borra de la tabla viva). Lo que
-- se comprueba es que, al recuperarlo, sea ESE diagnóstico de vuelta.
--
-- Una función PROPIA para el UPDATE y el DELETE del archivo:
-- `encounter_diagnosis_retraction_is_append_only` la comparten los TRUNCATE
-- del archivo y de la tabla viva, y no puede leer columnas de una sola.
CREATE OR REPLACE FUNCTION encounter_diagnosis_retraction_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- EN-213. La única escritura admitida: marcar UNA vez quién lo recuperó.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.restored_at IS NULL
       AND NEW.restored_at IS NOT NULL
       AND (to_jsonb(NEW) - 'restored_at' - 'restored_by_id' - 'restored_as_id')
           = (to_jsonb(OLD) - 'restored_at' - 'restored_by_id' - 'restored_as_id') THEN
      IF NOT EXISTS (SELECT 1 FROM encounter_diagnosis d
                      WHERE d.id = NEW.restored_as_id
                        AND d.id <> OLD.id
                        AND d.encounter_id = OLD.encounter_id
                        AND d.concept_id = OLD.concept_id) THEN
        RAISE EXCEPTION
          'encounter_diagnosis_retraction_restored_as_itself: a removed diagnosis is restored as the same diagnosis, back on its attention'
          USING ERRCODE = 'integrity_constraint_violation',
                HINT = 'EN-213.';
      END IF;
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'encounter_diagnosis_retraction_frozen: the archive of removed diagnoses never changes'
    USING ERRCODE = 'integrity_constraint_violation',
          HINT = 'EN-180, EN-213.';
END;
$$;

DROP TRIGGER "encounter_diagnosis_retraction_frozen" ON "encounter_diagnosis_retraction";
CREATE TRIGGER "encounter_diagnosis_retraction_frozen"
  BEFORE UPDATE OR DELETE ON "encounter_diagnosis_retraction"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_diagnosis_retraction_guard();
