-- encounter_coding_after_discharge
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-215 (D-117.12, D-127): LA CODIFICACIÓN DE LA ATENCIÓN SE CORRIGE TRAS EL ALTA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El RDACAA lee de la atención —no de la nota— sus diagnósticos, su modalidad
-- (morbilidad o prevención, EN-187) y si es de primera vez o subsecuente
-- (EN-007). Hasta aquí, tras el alta sólo se quitaba un diagnóstico o se
-- cambiaba el principal: el correcto no se podía registrar, y la modalidad y
-- la primera vez no se corregían. D-117.12 (bajada a D-126) lo abre con una
-- confirmación en la pantalla y sin motivo; D-117.13 (`record:sign` y
-- licencia vigente) es del servicio, porque la base no conoce la sesión.
--
-- LO QUE GARANTIZA ESTA MIGRACIÓN:
--   · `trg_encounter_record_version`: corregir la modalidad o la primera vez
--     exige un sello nuevo (`corrected_by_id`, `corrected_at`) y archiva la
--     atención anterior entera en `record_version` (EN-210). SÓLO cuando cambia
--     una de esas dos columnas: el resto de escrituras de la atención —el alta,
--     interrumpir, anular, el reporte— no llevan sello ni dejan versión.
--   · D-117.16: una atención ya reportada al RDACAA no admite un diagnóstico
--     nuevo (`encounter_diagnosis_reported`, también al INSERT) ni que se
--     corrija su modalidad o su primera vez (`encounter_reported`): la
--     corrección no llegaría al Ministerio, porque nada la reenvía.
--
-- LO QUE NO GARANTIZA: que el diagnóstico nuevo tras el alta lo registre
-- quien firma historia (D-117.13), ni el estado en que se admite (interrumpida
-- o anulada lo rechaza el servicio con `ENCOUNTER_ALREADY_CLOSED`, como al
-- quitar, EN-180).
--
-- ⚠️ EL PRECIO DE LA CONSULTA NO SE RECALCULA AQUÍ. Cambiar la primera vez por
-- subsecuente cambia qué consulta se cobra (BI-158), pero el cargo es de
-- `billing` y lo propone caja al enviar la atención; un cargo ya propuesto y
-- sin facturar queda como estaba. Ver el informe de la rama.
--
-- NO SE TOCA NINGUNA FILA GUARDADA. `ADD COLUMN` sin defecto no ejecuta un
-- UPDATE ni dispara nada: las atenciones que existan quedan con el sello
-- vacío, que es la verdad («nadie corrigió su codificación»).

ALTER TABLE "encounter"
  ADD COLUMN "corrected_by_id" UUID,
  ADD COLUMN "corrected_at" TIMESTAMPTZ(6);

ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_corrected_by_id_fkey"
  FOREIGN KEY ("corrected_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Quién y cuándo, juntos o ninguno. Toda fila existente tiene los dos vacíos.
ALTER TABLE "encounter"
  ADD CONSTRAINT "encounter_correction_stamped" CHECK (
    ("corrected_by_id" IS NULL) = ("corrected_at" IS NULL)
  );

-- ── D-117.16: la atención reportada no se corrige ──────────────────────────
-- El nombre va PRIMERO en el mensaje: es como `database-problem.ts` lee qué
-- regla saltó en un disparador.
CREATE FUNCTION encounter_coding_correction_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.reported_at IS NOT NULL THEN
    RAISE EXCEPTION
      'encounter_reported: the attention was already reported to the RDACAA, and a correction would not reach it'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-215, D-117.16.';
  END IF;
  RETURN NEW;
END;
$$;

-- Antes que el de versiones (orden alfabético de los BEFORE): lo que se
-- rechaza no llega a archivar nada.
CREATE TRIGGER "trg_encounter_coding_correction_admits"
  BEFORE UPDATE OF "careModality", "visitSequence" ON "encounter"
  FOR EACH ROW
  WHEN (OLD."careModality" IS DISTINCT FROM NEW."careModality"
        OR OLD."visitSequence" IS DISTINCT FROM NEW."visitSequence")
  EXECUTE FUNCTION encounter_coding_correction_admits();

-- ── D-127.2: la versión anterior la guarda la base ─────────────────────────
-- El WHEN es lo que deja fuera al resto de escrituras de la atención: sin él,
-- dar el alta exigiría un sello de corrección.
CREATE TRIGGER "trg_encounter_record_version"
  BEFORE UPDATE OF "careModality", "visitSequence" ON "encounter"
  FOR EACH ROW
  WHEN (OLD."careModality" IS DISTINCT FROM NEW."careModality"
        OR OLD."visitSequence" IS DISTINCT FROM NEW."visitSequence")
  EXECUTE FUNCTION record_version_archive('corrected_by_id', 'corrected_at', 'id');

-- ── D-117.16: tampoco un diagnóstico nuevo en la atención reportada ────────
-- `encounter_diagnosis_edit_admits` ya lo dice del UPDATE (EN-212) y el
-- archivo del quitar (EN-213); faltaba registrar, que tras el alta ahora se
-- admite (EN-215).
CREATE FUNCTION encounter_diagnosis_insert_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF encounter_is_reported(NEW.encounter_id) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_reported: the attention was already reported to the RDACAA, and a correction would not reach it'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-215, D-117.16.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_diagnosis_insert_admits"
  BEFORE INSERT ON "encounter_diagnosis"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_diagnosis_insert_admits();
