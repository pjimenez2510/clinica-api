-- encounter_diagnosis_edit_in_place
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-212 (D-127): UN DIAGNÓSTICO SE EDITA EN EL SITIO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta aquí un diagnóstico mal puesto se QUITABA y se registraba otro: lo que
-- un diagnóstico es —su código, su concepto— no se reescribía
-- (`encounter_diagnosis_identity_frozen`, EN-180), y tras el alta el principal
-- sólo cambiaba quitándolo con su motivo (rama G2 de
-- `encounter_diagnosis_rank_frozen_when_cited`, EN-188). D-127 lo sustituye:
-- el código, la condición, la ocurrencia y el principal se editan, y la
-- versión anterior la guarda `record_version`, con quién y cuándo, en la misma
-- sentencia. Lo que hacían de prueba aquellos dos disparadores —que no se
-- pierda lo que se dijo— lo sigue haciendo la versión.
--
-- LO QUE SIGUE IGUAL:
--   · EN-041, EN-042: el código es el del concepto y el concepto regía el día
--     de la atención. Los dos disparadores pasan a mirar también el UPDATE.
--     La descripción la pone la base, del concepto: nadie la escribe.
--   · EN-043: nunca dos principales (`encounter_diagnosis_one_primary`).
--   · EN-188 G1 (no se quita el último tras el alta) y EN-020 (la 002 no se
--     firma sin diagnóstico): editar no quita nada.
--   · EN-182: el disparador del rango sigue mirando la orden con exámenes
--     vivos. Que deje de hacerlo es ORD-121, en otra migración.
--
-- LO NUEVO QUE SE RECHAZA, en `encounter_diagnosis_edit_admits`:
--   · el cambio de CÓDIGO de un diagnóstico que un papel en manos de un
--     tercero imprimió —certificado emitido (EN-189) o receta emitida
--     (D-117.14), vigentes o anulados— sin motivo (`edit_reason`);
--   · el cambio de CÓDIGO que dejaría sin diagnóstico obstétrico a un reposo
--     de maternidad no anulado de la atención (D-117.15): la salida es anular
--     el reposo;
--   · cualquier edición en una atención ya reportada al RDACAA (D-117.16): la
--     corrección no llegaría al Ministerio, porque no se reenvía.
--
-- ⚠️ LO QUE LA BASE NO PUEDE GARANTIZAR del motivo: que sea de ESTA edición y
-- no uno que quedó en la fila de la anterior. La API lo escribe siempre (nulo
-- si no hace falta); un psql que cambie el código y deje el motivo de antes
-- pasaría. Es el mismo hueco que el autor del sello (20261005050100).
--
-- NO SE TOCA NINGUNA FILA GUARDADA. `ADD COLUMN` sin defecto no ejecuta un
-- UPDATE ni dispara nada: los diagnósticos que existan quedan con el sello
-- vacío, que es la verdad («nadie lo ha editado»).

ALTER TABLE "encounter_diagnosis"
  ADD COLUMN "edited_by_id" UUID,
  ADD COLUMN "edited_at" TIMESTAMPTZ(6),
  ADD COLUMN "edit_reason" VARCHAR(500);

ALTER TABLE "encounter_diagnosis"
  ADD CONSTRAINT "encounter_diagnosis_edited_by_id_fkey"
  FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Quién y cuándo, juntos o ninguno. Toda fila existente tiene los dos vacíos.
ALTER TABLE "encounter_diagnosis"
  ADD CONSTRAINT "encounter_diagnosis_edit_stamped" CHECK (
    ("edited_by_id" IS NULL) = ("edited_at" IS NULL)
  );

-- Un motivo vacío o de espacios no es un motivo.
ALTER TABLE "encounter_diagnosis"
  ADD CONSTRAINT "encounter_diagnosis_edit_reason_not_blank"
  CHECK ("edit_reason" IS NULL OR btrim("edit_reason") <> '');

-- ── EN-212: lo que un diagnóstico ES ya se edita ────────────────────────────
DROP TRIGGER "encounter_diagnosis_identity_frozen" ON "encounter_diagnosis";
DROP FUNCTION encounter_diagnosis_identity_is_frozen();

-- ── EN-041: el código editado sigue siendo el de su concepto ───────────────
-- En el UPDATE la descripción también la pone la base, del concepto: con la
-- identidad editable, una descripción tecleada sería la forma de que una
-- mentira entre (la descripción de otro código junto a éste).
CREATE OR REPLACE FUNCTION diagnosis_snapshot_matches_concept()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_code text; v_display text;
BEGIN
  SELECT code, display INTO v_code, v_display
    FROM catalog_concept WHERE id = NEW.concept_id;

  IF NEW.cie10_code IS DISTINCT FROM v_code THEN
    RAISE EXCEPTION 'frozen cie10_code % does not match concept % (%)',
      NEW.cie10_code, NEW.concept_id, v_code
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.cie10_display := v_display;
  ELSE
    NEW.cie10_display := coalesce(NEW.cie10_display, v_display);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "trg_diagnosis_snapshot" ON "encounter_diagnosis";
CREATE TRIGGER "trg_diagnosis_snapshot"
  BEFORE INSERT OR UPDATE OF "concept_id", "cie10_code", "cie10_display"
  ON "encounter_diagnosis"
  FOR EACH ROW EXECUTE FUNCTION diagnosis_snapshot_matches_concept();

-- ── EN-042: y regía el día de la atención ──────────────────────────────────
DROP TRIGGER "trg_diagnosis_concept_in_force" ON "encounter_diagnosis";
CREATE TRIGGER "trg_diagnosis_concept_in_force"
  BEFORE INSERT OR UPDATE OF "concept_id", "encounter_id"
  ON "encounter_diagnosis"
  FOR EACH ROW EXECUTE FUNCTION diagnosis_concept_in_force();

-- ── EN-189, D-117.14: ¿un papel en manos de un tercero imprimió el código? ─
-- UNA función para el disparador y para el servicio, como
-- `encounter_has_document_citing_diagnoses`: la frase y la garantía no pueden
-- discrepar sobre cuándo se debe el motivo. El certificado y la receta
-- CONGELARON sus diagnósticos al emitirse (CER-027, PR-026); también el
-- anulado: el papel pudo circular antes.
CREATE OR REPLACE FUNCTION encounter_diagnosis_code_on_paper(
  p_encounter_id uuid,
  p_cie10_code   text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1
                   FROM medical_certificate c,
                        jsonb_array_elements(c.diagnoses) AS printed
                  WHERE c.encounter_id = p_encounter_id
                    AND printed ->> 'code' = p_cie10_code)
      OR EXISTS (SELECT 1
                   FROM prescription p,
                        jsonb_array_elements(p.diagnoses) AS printed
                  WHERE p.encounter_id = p_encounter_id
                    AND p.issued_at IS NOT NULL
                    AND printed ->> 'code' = p_cie10_code);
$$;

-- ── D-117.15: el diagnóstico que sostiene un reposo de maternidad ──────────
-- El patrón es el de CER-049 (`medical_certificate_maternity_obstetric_diagnosis`):
-- O00–O99 y Z34–Z39 con sus subcategorías.
CREATE OR REPLACE FUNCTION cie10_is_obstetric(p_code text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_code ~ '^(O[0-9]{2}|Z3[4-9])[0-9A-Z]*$';
$$;

-- ¿Quedaría el reposo de maternidad no anulado de la atención sin ningún
-- diagnóstico obstétrico si `p_diagnosis_id` dejara de serlo?
CREATE OR REPLACE FUNCTION encounter_diagnosis_supports_maternity_rest(
  p_encounter_id uuid,
  p_diagnosis_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM medical_certificate c
                  WHERE c.encounter_id = p_encounter_id
                    AND c.type = 'MEDICAL_REST'
                    AND c.contingency_type = 'MATERNITY'
                    AND c.revoked_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM encounter_diagnosis d
                      WHERE d.encounter_id = p_encounter_id
                        AND d.id <> p_diagnosis_id
                        AND cie10_is_obstetric(d.cie10_code));
$$;

-- ── D-117.16: una atención ya reportada al RDACAA ──────────────────────────
CREATE OR REPLACE FUNCTION encounter_is_reported(p_encounter_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (SELECT 1 FROM encounter e
                  WHERE e.id = p_encounter_id
                    AND e.reported_at IS NOT NULL);
$$;

-- ── EN-212: lo que una edición tiene que respetar ──────────────────────────
-- Los nombres van PRIMERO en el mensaje: es como `database-problem.ts` lee
-- qué regla saltó en un disparador.
CREATE OR REPLACE FUNCTION encounter_diagnosis_edit_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.encounter_id IS DISTINCT FROM OLD.encounter_id THEN
    RAISE EXCEPTION
      'encounter_diagnosis_stays_on_its_encounter: a diagnosis does not move to another attention'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-212.';
  END IF;

  IF encounter_is_reported(OLD.encounter_id) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_reported: the attention was already reported to the RDACAA, and a correction would not reach it'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-212, D-117.16.';
  END IF;

  IF NEW.cie10_code IS DISTINCT FROM OLD.cie10_code THEN
    IF NEW.edit_reason IS NULL
       AND encounter_diagnosis_code_on_paper(OLD.encounter_id, OLD.cie10_code) THEN
      RAISE EXCEPTION
        'encounter_diagnosis_edit_reason: an issued certificate or receta printed this code, so changing it states why'
        USING ERRCODE = 'integrity_constraint_violation',
              HINT = 'EN-212, EN-189, D-117.14.';
    END IF;

    IF cie10_is_obstetric(OLD.cie10_code)
       AND NOT cie10_is_obstetric(NEW.cie10_code)
       AND encounter_diagnosis_supports_maternity_rest(OLD.encounter_id, OLD.id) THEN
      RAISE EXCEPTION
        'encounter_diagnosis_supports_maternity_rest: a maternity rest in force stands on this obstetric diagnosis'
        USING ERRCODE = 'integrity_constraint_violation',
              HINT = 'EN-212, D-117.15. Annul the rest first.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Antes que el de versiones (orden alfabético de los BEFORE): lo que se
-- rechaza no llega a archivar nada.
CREATE TRIGGER "trg_encounter_diagnosis_edit_admits"
  BEFORE UPDATE ON "encounter_diagnosis"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_diagnosis_edit_admits();

-- ── EN-212: tras el alta el principal cambia de un clic (fuera G2) ─────────
-- Queda sólo la rama de EN-182, que ORD-121 retira en otra migración.
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
  RETURN NEW;
END;
$$;

-- ── D-127.2: la versión anterior la guarda la base ─────────────────────────
-- «record_version» va después de «edit_admits» y de «rank_frozen»: un UPDATE
-- rechazado no archiva nada.
CREATE TRIGGER "trg_encounter_diagnosis_record_version"
  BEFORE UPDATE ON "encounter_diagnosis"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('edited_by_id', 'edited_at', 'id');
