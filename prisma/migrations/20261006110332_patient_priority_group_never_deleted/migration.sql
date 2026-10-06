-- patient_priority_group_never_deleted
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- PA-037: UN REGISTRO DE GRUPO PRIORITARIO NO SE BORRA, TAMPOCO DESDE LA BASE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- PA-037 dice que cerrar NO borra la fila, y la API no tiene ruta que borre.
-- Pero la base lo permitía: un DELETE suelto, un TRUNCATE o borrar la ficha
-- (ON DELETE CASCADE) se llevaban la respuesta a «¿por qué esta persona tuvo
-- prioridad en marzo?» y, desde PA-066, las versiones de la fila quedaban
-- huérfanas en `record_version`. Las demás tablas que se corrigen con versión
-- —alergia, antecedente, «sin alergias conocidas»— ya rechazan DELETE y
-- TRUNCATE; ésta se queda igual.
--
--   · `trg_patient_priority_group_never_deleted` (BEFORE DELETE, por fila) y
--     `trg_patient_priority_group_never_truncated` (BEFORE TRUNCATE, por
--     sentencia) rechazan con el nombre `patient_priority_group_never_deleted`
--     delante del mensaje, que es como `database-problem.ts` lee la regla.
--   · `patient_priority_group_patient_id_fkey` pasa de CASCADE a RESTRICT: en
--     un sistema clínico no se borra en cascada. Con el disparador, el
--     CASCADE ya no podía borrar nada (la cascada dispara el BEFORE DELETE);
--     RESTRICT lo dice en el sitio que corresponde y con el nombre de la FK.
--
-- NO SE TOCA NINGUNA FILA. Recrear la FK la valida contra las filas que hay,
-- que ya la cumplen. La única escritura que deja de funcionar es borrar una
-- ficha con grupos prioritarios —el sembrado de pacientes de desarrollo, que
-- ya fallaba con una ficha con alergias—; el arnés de pruebas vacía con
-- `TRUNCATE … CASCADE` en modo réplica, que no dispara los disparadores.

CREATE FUNCTION patient_priority_group_never_deleted()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'patient_priority_group_never_deleted: a priority group record is never deleted (operation %)', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'PA-037. Un registro se cierra fechándolo y se corrige con versión (PA-066); no se borra.';
END;
$$;

CREATE TRIGGER "trg_patient_priority_group_never_deleted"
  BEFORE DELETE ON "patient_priority_group"
  FOR EACH ROW
  EXECUTE FUNCTION patient_priority_group_never_deleted();

CREATE TRIGGER "trg_patient_priority_group_never_truncated"
  BEFORE TRUNCATE ON "patient_priority_group"
  FOR EACH STATEMENT
  EXECUTE FUNCTION patient_priority_group_never_deleted();

ALTER TABLE "patient_priority_group"
  DROP CONSTRAINT "patient_priority_group_patient_id_fkey",
  ADD CONSTRAINT "patient_priority_group_patient_id_fkey"
    FOREIGN KEY ("patient_id") REFERENCES "patient"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
