-- critical_notice_edit_in_place
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- ORD-120, ENMIENDA DE ORD-064 (D-127, 04-10-2026)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La constancia del aviso de un valor crítico era de SOLO INSERCIÓN: el aviso
-- mal anotado se corregía registrando otro, y la constancia equivocada se
-- quedaba al lado de la buena. D-127 manda editar en el sitio y que la versión
-- anterior la guarde el sistema. Lo que hacía de prueba —que nada se pierda—
-- lo sigue haciendo `record_version`: cada edición archiva la fila anterior
-- entera, con quién y cuándo, en la misma sentencia.
--
-- LO QUE SIGUE SIN CAMBIAR NUNCA, porque es lo que hace de la fila la
-- constancia de un acto:
--   - de qué valor es (`observation_result_id`),
--   - quién avisó (`notified_by_id`): quien edita queda en `edited_by_id`,
--   - cuándo se anotó (`created_at`) y su identificador.
-- Y sigue sin poder borrarse ni vaciarse.
--
-- EL READ-BACK SIGUE OBLIGATORIO (ORD-066, seguridad del paciente):
-- `critical_result_notice_read_back` se comprueba en cada UPDATE, también
-- sobre las constancias anteriores a D-111 que nacieron sin él (el CHECK es
-- NOT VALID). Editar una de ellas exige confirmarlo.
--
-- NO SE TOCA NINGUNA FILA GUARDADA. `ADD COLUMN` sin defecto no ejecuta un
-- UPDATE ni dispara los disparadores de fila: las constancias que existan
-- quedan con el sello vacío, que es la verdad («nadie la ha editado»).

ALTER TABLE "critical_result_notice"
  ADD COLUMN "edited_by_id" UUID,
  ADD COLUMN "edited_at" TIMESTAMPTZ(6);

ALTER TABLE "critical_result_notice"
  ADD CONSTRAINT "critical_result_notice_edited_by_id_fkey"
  FOREIGN KEY ("edited_by_id") REFERENCES "app_user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Quién y cuándo, juntos o ninguno. Toda fila existente tiene los dos vacíos.
ALTER TABLE "critical_result_notice"
  ADD CONSTRAINT "critical_result_notice_edit_stamped" CHECK (
    ("edited_by_id" IS NULL) = ("edited_at" IS NULL)
  );

-- ORD-064 enmendado: ni DELETE, ni un UPDATE que cambie el origen. El resto
-- de la edición lo admite, y `record_version_archive` exige el sello.
--
-- Los mensajes llevan «append-only» y «cannot be modified» a propósito:
-- `database-problem.ts` sólo traduce a 409 los 42501 de nuestros disparadores
-- reconociéndolos por el texto.
CREATE OR REPLACE FUNCTION critical_result_notice_keeps_its_origin()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'critical_result_notice is append-only: operation % is forbidden', TG_OP
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'El aviso de un valor crítico no se borra: se edita, y la '
                   'versión anterior se guarda.';
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."observation_result_id" IS DISTINCT FROM OLD."observation_result_id"
     OR NEW."notified_by_id" IS DISTINCT FROM OLD."notified_by_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION
      'critical_result_notice cannot be modified in its origin: the value, who gave the notice and when it was written down are fixed'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Quien edita queda en edited_by_id; un aviso de otro valor '
                   'se registra aparte.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER "trg_critical_result_notice_append_only" ON "critical_result_notice";

-- Los BEFORE de una misma tabla se disparan por orden alfabético de nombre:
-- «keeps_its_origin» va antes que «record_version», así que un UPDATE que
-- cambia el origen se rechaza sin llegar a archivar nada.
CREATE TRIGGER "trg_critical_result_notice_keeps_its_origin"
  BEFORE UPDATE OR DELETE ON "critical_result_notice"
  FOR EACH ROW
  EXECUTE FUNCTION critical_result_notice_keeps_its_origin();

CREATE TRIGGER "trg_critical_result_notice_record_version"
  BEFORE UPDATE ON "critical_result_notice"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('edited_by_id', 'edited_at', 'id');

-- `trg_critical_result_notice_no_truncate` y la función
-- `critical_result_notice_append_only` se quedan: TRUNCATE sigue prohibido.
