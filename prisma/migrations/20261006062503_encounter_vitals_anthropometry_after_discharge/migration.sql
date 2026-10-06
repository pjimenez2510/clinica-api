-- encounter_vitals_anthropometry_after_discharge
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-217, D-134.3: TRAS EL ALTA, CORREGIR LA TOMA NO DEJA PENDIENTE EL PESO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La 002 no se firma —no da el alta— sin la antropometría que EN-063 hace
-- obligatoria al menor de 5 años y a la embarazada
-- (`trg_clinical_note_sign_needs_anthropometry`). Pero tras el alta la toma se
-- sigue corrigiendo (EN-217), y una corrección que borrara el peso dejaba la
-- atención con el alta y sin el dato que el RDACAA exige: exactamente lo que
-- la firma impidió. D-134.3, mientras el autor decide quién corrige tras el
-- alta: ninguna corrección puede dejar pendiente el peso o la talla
-- obligatorios.
--
-- LA MISMA FUNCIÓN que la firma y que la respuesta de la toma:
-- `encounter_anthropometry_pending`, después de escribir la fila (AFTER), con
-- `encounter_has_discharge`. DIFERIDO, como el de la firma: el adaptador
-- escribe la corrección, pregunta a la misma función dentro de su transacción
-- y rechaza nombrando cada medida antes del COMMIT; el disparador es lo que
-- responde a quien llegue por otro camino.
--
-- LECTURA LITERAL: tras escribir la fila no puede faltar nada obligatorio,
-- aunque ya faltara antes (un embarazo registrado después con fecha de inicio
-- anterior a la atención). La salida es completar la medida en la misma
-- corrección. El servicio lo rechaza antes, bajo el bloqueo de la atención,
-- nombrando cada medida; esto es para lo que llegue por otro camino.
--
-- NO SE TOCA NINGUNA FILA GUARDADA: el disparador sólo mira las escrituras de
-- aquí en adelante.

-- El nombre va PRIMERO en el mensaje: es como `database-problem.ts` lee qué
-- regla saltó en un disparador.
CREATE FUNCTION encounter_vitals_anthropometry_after_discharge()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF encounter_has_discharge(NEW.encounter_id)
     AND cardinality(encounter_anthropometry_pending(NEW.encounter_id)) > 0 THEN
    RAISE EXCEPTION
      'encounter_vitals_anthropometry_after_discharge: the attention is discharged, and a correction of its taking cannot leave the mandatory anthropometry missing'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-217, EN-063, D-134.3.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_encounter_vitals_anthropometry_after_discharge
  AFTER INSERT OR UPDATE ON encounter_vitals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION encounter_vitals_anthropometry_after_discharge();
