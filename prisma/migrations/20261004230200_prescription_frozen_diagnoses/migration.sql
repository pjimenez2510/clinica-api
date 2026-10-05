-- Revisión clínica de fix/atencion-receta-diagnosticos (G1, G2, I2).

-- ═════════════════════════════════════════════════════════════════════════════
-- PR-026, EN-182. La receta CONGELA sus diagnósticos al emitirse, como el
-- certificado (CER-011). Antes los leía vivos de la atención: quitar o
-- reordenar un diagnóstico cambiaba lo que dice un papel ya entregado, y la
-- única «salida» que se ofrecía —anular la receta— no lo era, porque la
-- anulada conserva `issued_at` y seguía contando.
-- ═════════════════════════════════════════════════════════════════════════════

-- ⚠️ REAPLICABLE. PostgreSQL ejecuta esta migración sentencia a sentencia y
-- sin una transacción que la envuelva: la primera versión se cortó en el
-- UPDATE de abajo con la columna YA creada (base del autor, 04-10-2026). Cada
-- paso es idempotente para que volver a aplicarla complete lo que falte.
ALTER TABLE "prescription" ADD COLUMN IF NOT EXISTS "diagnoses" JSONB;

-- Las ya emitidas: lo que hay ahora es lo único que se sabe de entonces.
--
-- ⚠️ CON `prescription_frozen` APAGADO MIENTRAS DURA EL RELLENO, Y SÓLO
-- ENTONCES. Ese disparador no deja cambiar en una receta emitida más que su
-- estado, y esta columna nueva es precisamente lo que una emitida aún no tiene:
-- rellenarla es completar el registro, no editarlo. `DISABLE TRIGGER` con
-- nombre (no `ALL`) lo puede hacer el dueño de la tabla sin superusuario, y
-- deja activas las demás garantías.
ALTER TABLE "prescription" DISABLE TRIGGER "prescription_frozen";

UPDATE "prescription" p
   SET "diagnoses" = COALESCE((
         SELECT jsonb_agg(jsonb_build_object('code', d.cie10_code, 'display', d.cie10_display)
                          ORDER BY d.rank, d.recorded_at)
           FROM encounter_diagnosis d
          WHERE d.encounter_id = p.encounter_id), '[]'::jsonb)
 WHERE p.issued_at IS NOT NULL
   AND p.diagnoses IS NULL;

ALTER TABLE "prescription" ENABLE TRIGGER "prescription_frozen";

ALTER TABLE "prescription"
  DROP CONSTRAINT IF EXISTS "prescription_diagnoses_frozen_when_issued";
ALTER TABLE "prescription"
  ADD CONSTRAINT "prescription_diagnoses_frozen_when_issued"
  CHECK (("issued_at" IS NULL) = ("diagnoses" IS NULL)
         AND ("diagnoses" IS NULL OR jsonb_typeof("diagnoses") = 'array'));

-- Lo copia la BASE en el instante de la emisión, sea quien sea quien emite: la
-- copia no puede venir del llamador.
CREATE OR REPLACE FUNCTION prescription_freeze_diagnoses()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.issued_at IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.issued_at IS NULL) THEN
    NEW.diagnoses := COALESCE((
      SELECT jsonb_agg(jsonb_build_object('code', d.cie10_code, 'display', d.cie10_display)
                       ORDER BY d.rank, d.recorded_at)
        FROM encounter_diagnosis d
       WHERE d.encounter_id = NEW.encounter_id), '[]'::jsonb);
  END IF;
  RETURN NEW;
END;
$$;

-- «a_» para correr antes que `prescription_frozen` (orden alfabético).
DROP TRIGGER IF EXISTS "a_prescription_freeze_diagnoses" ON "prescription";
CREATE TRIGGER "a_prescription_freeze_diagnoses"
  BEFORE INSERT OR UPDATE ON "prescription"
  FOR EACH ROW
  EXECUTE FUNCTION prescription_freeze_diagnoses();

-- ═════════════════════════════════════════════════════════════════════════════
-- EN-182. Sólo la ORDEN sigue leyendo los diagnósticos vivos, y sólo mientras
-- tenga algún examen sin anular: anular los exámenes (ORD-007) es la salida.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION encounter_has_document_citing_diagnoses(p_encounter_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1
                   FROM service_order o
                   JOIN service_order_item i ON i.service_order_id = o.id
                  WHERE o.encounter_id = p_encounter_id
                    AND i.status <> 'CANCELLED');
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- EN-180, I2. Lo que un diagnóstico ES no se edita: se quita y se registra
-- otro. Sin esto, un UPDATE del código seguido del archivo archivaba «una
-- versión arreglada», justo lo que el archivo existe para impedir.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION encounter_diagnosis_identity_is_frozen()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.concept_id IS DISTINCT FROM OLD.concept_id
     OR NEW.cie10_code IS DISTINCT FROM OLD.cie10_code
     OR NEW.cie10_display IS DISTINCT FROM OLD.cie10_display
     OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id THEN
    RAISE EXCEPTION
      'encounter_diagnosis_identity_frozen: a diagnosis is removed and recorded again, never rewritten'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-180.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "encounter_diagnosis_identity_frozen" ON "encounter_diagnosis";
CREATE TRIGGER "encounter_diagnosis_identity_frozen"
  BEFORE UPDATE ON "encounter_diagnosis"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_diagnosis_identity_is_frozen();

-- ═════════════════════════════════════════════════════════════════════════════
-- PR-101, G2. Una dosis de 0,125 mg no cabe en dos decimales: se guardaba
-- 0,13 y el borrador reabierto la reescribía un 4 % más alta.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "prescription_item" ALTER COLUMN "dose_amount" TYPE DECIMAL(12,4);
