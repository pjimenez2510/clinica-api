-- EN-188. Después del alta, corregir la codificación sin dejarla rota ni sin
-- rastro (revisión clínica del 04-10-2026, G1 y G2).
--
-- G1. Quitar el ÚLTIMO diagnóstico de una atención con el alta la dejaría sin
-- ninguno, y tras el alta no se registra uno nuevo (EN-009; si debe poderse es
-- D-117.12). El RDACAA recibiría una atención sin diagnóstico.
--
-- G2. Reordenar el principal tras el alta cambia lo que se informa sin motivo
-- y sin rastro del anterior. La salida que deja rastro es QUITAR el principal
-- equivocado con su motivo —el archivo lo guarda con su rango 1— y después
-- nombrar otro donde ya no hay principal. Eso es lo único que se admite.
--
-- No toca datos: reemplaza dos funciones de disparadores que ya existen.

CREATE OR REPLACE FUNCTION encounter_has_discharge(p_encounter_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM encounter e
                  WHERE e.id = p_encounter_id
                    AND e.status IN ('DISCHARGED', 'COMPLETED'));
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

  IF encounter_has_discharge(NEW.encounter_id)
     AND (SELECT count(*) FROM encounter_diagnosis d
           WHERE d.encounter_id = NEW.encounter_id) <= 1 THEN
    RAISE EXCEPTION
      'encounter_diagnosis_last_after_discharge: a discharged attention keeps at least one diagnosis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-188, D-117.12.';
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

CREATE OR REPLACE FUNCTION encounter_diagnosis_rank_frozen_when_cited()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.rank IS DISTINCT FROM OLD.rank
     AND encounter_has_document_citing_diagnoses(OLD.encounter_id) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_cited: an issued order with exams not cancelled reads these diagnoses'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-182. Cancel the exams first.';
  END IF;

  -- EN-188. After the discharge a rank moves only to fill an EMPTY principal.
  IF NEW.rank IS DISTINCT FROM OLD.rank
     AND encounter_has_discharge(OLD.encounter_id)
     AND NOT (NEW.rank = 1
              AND NOT EXISTS (SELECT 1 FROM encounter_diagnosis d
                               WHERE d.encounter_id = OLD.encounter_id
                                 AND d.rank = 1
                                 AND d.id <> OLD.id)) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_rank_frozen_after_discharge: after the discharge the principal changes by removing it with a reason'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-188.';
  END IF;

  RETURN NEW;
END;
$$;
