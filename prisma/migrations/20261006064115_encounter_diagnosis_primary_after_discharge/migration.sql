-- encounter_diagnosis_primary_after_discharge
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-183, EN-188: CON EL ALTA, LA ATENCIÓN NUNCA QUEDA SIN PRINCIPAL
-- ═══════════════════════════════════════════════════════════════════════════
--
-- El RDACAA lee la causa de la consulta del diagnóstico principal (rango 1).
-- Desde EN-212 el principal se edita y se desmarca, y desde EN-213 se quita
-- tras el alta sin motivo: cualquiera de las dos dejaba una atención con el
-- alta y SIN principal, que ya nadie arregla al firmar porque la 002 está
-- firmada. EN-188 G1 impedía quedarse sin diagnóstico; esto impide quedarse
-- sin principal.
--
-- LO COHERENTE CON EN-183: la salida de quitar el principal es marcar otro
-- como principal, y ese cambio mueve los dos rangos en UNA transacción (el
-- anterior pasa detrás). No se promueve ninguno solo: elegir cuál es la causa
-- de la consulta es del médico. Por eso es DIFERIDO: a mitad de la
-- transacción de EN-183 no hay principal, y al COMMIT sí.
--
-- SÓLO LO QUE PIERDE EL PRINCIPAL: un UPDATE de rango que lo saca del 1, o un
-- DELETE del que lo era. Una atención con el alta que ya no tuviera principal
-- (anterior a esta regla, o quitado antes de firmar) no se toca, y editar sus
-- secundarios sigue admitiéndose.
--
-- El servicio lo rechaza antes, bajo el bloqueo de la atención, con
-- `DIAGNOSIS_PRIMARY_REQUIRED_AFTER_DISCHARGE`; esto es para lo que llegue por
-- otro camino. NO SE TOCA NINGUNA FILA GUARDADA.

-- El nombre va PRIMERO en el mensaje: es como `database-problem.ts` lee qué
-- regla saltó en un disparador.
CREATE FUNCTION encounter_diagnosis_primary_after_discharge()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF encounter_has_discharge(OLD.encounter_id)
     AND NOT EXISTS (SELECT 1 FROM encounter_diagnosis d
                      WHERE d.encounter_id = OLD.encounter_id
                        AND d.rank = 1) THEN
    RAISE EXCEPTION
      'encounter_diagnosis_primary_after_discharge: a discharged attention keeps a principal diagnosis; mark another one first'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-183, EN-188.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_encounter_diagnosis_primary_after_discharge_update
  AFTER UPDATE OF rank ON encounter_diagnosis
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.rank = 1 AND NEW.rank IS DISTINCT FROM 1)
  EXECUTE FUNCTION encounter_diagnosis_primary_after_discharge();

CREATE CONSTRAINT TRIGGER trg_encounter_diagnosis_primary_after_discharge_delete
  AFTER DELETE ON encounter_diagnosis
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.rank = 1)
  EXECUTE FUNCTION encounter_diagnosis_primary_after_discharge();
