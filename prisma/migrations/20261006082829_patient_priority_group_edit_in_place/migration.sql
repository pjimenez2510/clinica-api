-- patient_priority_group_edit_in_place
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PA-066 (D-127): EL GRUPO PRIORITARIO SE EDITA EN SU FILA, CON VERSIÓN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Hasta aquí una valoración sólo se CERRABA (PA-037): el grupo, el inicio, el
-- origen o el documento mal tecleados no tenían arreglo, y un cierre
-- equivocado tampoco. D-127 lo sustituye: se edita en la fila, y la fila
-- anterior la guarda `record_version` en la misma sentencia
-- (`record_version_archive`, EN-210), con el sello nuevo `changed_by` /
-- `changed_at`.
--
-- ⚠️ DESDE AQUÍ TODO UPDATE LLEVA SELLO, TAMBIÉN EL CIERRE. Cerrar es un
-- UPDATE más: la API sella con quien cierra y cuándo, y la valoración abierta
-- queda como versión.
--
-- `patient_priority_group_closure_once` (de `fix/fallos-inventario`) SIGUE
-- con su nombre —es el que el contrato traduce a PRIORITY_GROUP_ALREADY_CLOSED—
-- y amplía lo que guarda, como anticipó la nota de su plan:
--   · `closed_at` y `closed_by` de una fila cerrada no cambian NUNCA: un
--     segundo cierre sigue rechazado.
--   · `ends_on` de una fila cerrada se CORRIGE sólo con sello nuevo (la
--     versión anterior la archiva el disparador de versiones) y nunca a NULL:
--     lo cerrado no se reabre vaciando el fin.
--   · y, abierta o cerrada, la fila no cambia de id, de paciente ni de quién
--     y cuándo la registró (PA-039).
-- Pasa a dispararse en TODO UPDATE y no sólo en el de las tres columnas del
-- cierre: si no, cambiar el paciente no lo vería.
--
-- ⚠️ El orden de los BEFORE UPDATE es alfabético: `…_closure_once` va antes
-- que `…_record_version`, así que lo que se rechaza no llega a archivar nada.
--
-- NO SE TOCA NINGUNA FILA GUARDADA. `ADD COLUMN` sin defecto no ejecuta un
-- UPDATE: las filas que existan quedan con el sello vacío, que es la verdad
-- («nadie la ha editado»). El CHECK nuevo se valida contra ellas.

ALTER TABLE "patient_priority_group"
  ADD COLUMN "changed_by" UUID,
  ADD COLUMN "changed_at" TIMESTAMPTZ(6);

ALTER TABLE "patient_priority_group"
  ADD CONSTRAINT "patient_priority_group_changed_by_fkey"
    FOREIGN KEY ("changed_by") REFERENCES "app_user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Quién y cuándo, juntos o ninguno.
  ADD CONSTRAINT "patient_priority_group_change_stamped" CHECK (
    ("changed_by" IS NULL) = ("changed_at" IS NULL)
  );

CREATE OR REPLACE FUNCTION patient_priority_group_closure_once()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."patient_id" IS DISTINCT FROM OLD."patient_id"
     OR NEW."recorded_by" IS DISTINCT FROM OLD."recorded_by"
     OR NEW."recorded_at" IS DISTINCT FROM OLD."recorded_at" THEN
    RAISE EXCEPTION
      'patient_priority_group_closure_once: a record never changes its patient or who recorded it'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'PA-039, PA-066.';
  END IF;

  IF OLD."closed_at" IS NOT NULL
     AND (NEW."closed_at" IS DISTINCT FROM OLD."closed_at"
          OR NEW."closed_by" IS DISTINCT FROM OLD."closed_by"
          OR (NEW."ends_on" IS DISTINCT FROM OLD."ends_on"
              AND (NEW."ends_on" IS NULL
                   OR NEW."changed_at" IS NULL
                   OR NEW."changed_at" IS NOT DISTINCT FROM OLD."changed_at"))) THEN
    RAISE EXCEPTION
      'patient_priority_group_closure_once: a closed record keeps its first closure'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'PA-037, PA-039. El fin de un cerrado se corrige con versión (PA-066), nunca se reabre.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "trg_patient_priority_group_closure_once" ON "patient_priority_group";
CREATE TRIGGER "trg_patient_priority_group_closure_once"
  BEFORE UPDATE ON "patient_priority_group"
  FOR EACH ROW
  EXECUTE FUNCTION patient_priority_group_closure_once();

CREATE TRIGGER "trg_patient_priority_group_record_version"
  BEFORE UPDATE ON "patient_priority_group"
  FOR EACH ROW
  EXECUTE FUNCTION record_version_archive('changed_by', 'changed_at', 'id');
