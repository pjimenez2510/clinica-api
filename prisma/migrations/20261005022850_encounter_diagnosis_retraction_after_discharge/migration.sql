-- EN-188, EN-189 (D-117.8, D-117.9). Quitar un diagnóstico después del alta, y
-- cuándo se debe un motivo.
--
-- Hasta aquí el motivo se debía sólo con una nota firmada (EN-181). Ahora
-- también:
--   · con el alta (`DISCHARGED`, `COMPLETED`): quitar después del alta se
--     admite para corregir lo que va al RDACAA, y siempre dice por qué. El alta
--     implica una 002 firmada, pero la regla es del alta y se dice por el estado;
--   · cuando un certificado emitido de la atención —vigente o anulado— imprimió
--     el código (`medical_certificate.diagnoses`, CER-027): el papel no cambia y
--     la historia tiene que explicar por qué dice otra cosa.
--
-- UNA FUNCIÓN para el disparador y para el servicio, como
-- `encounter_has_document_citing_diagnoses`: la frase y la garantía no pueden
-- discrepar sobre cuándo se debe el motivo.
--
-- No toca datos: sólo reemplaza funciones. El disparador del archivo
-- (`trg_encounter_diagnosis_retraction_admits`) ya existe y llama a la función
-- por su nombre.

CREATE OR REPLACE FUNCTION encounter_diagnosis_retraction_needs_reason(
  p_encounter_id uuid,
  p_cie10_code   text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM clinical_note n
                  WHERE n.encounter_id = p_encounter_id
                    AND n.signed_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM encounter e
                  WHERE e.id = p_encounter_id
                    AND e.status IN ('DISCHARGED', 'COMPLETED'))
      OR EXISTS (SELECT 1
                   FROM medical_certificate c,
                        jsonb_array_elements(c.diagnoses) AS printed
                  WHERE c.encounter_id = p_encounter_id
                    AND printed ->> 'code' = p_cie10_code);
$$;

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

  IF NEW.reason IS NULL
     AND encounter_diagnosis_retraction_needs_reason(NEW.encounter_id, NEW.cie10_code) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_retraction_reason: a signed note, the discharge or a printed certificate already state this diagnosis, so removing it states why'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-181, EN-188, EN-189.';
  END IF;

  IF encounter_has_document_citing_diagnoses(NEW.encounter_id) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_cited: an order with exams not cancelled reads these diagnoses'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-182. Cancel the exams first.';
  END IF;

  RETURN NEW;
END;
$$;
