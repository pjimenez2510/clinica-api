-- EN-020. Firmar la nota de consulta externa (002) exige al menos un
-- diagnóstico en la atención (fix/fallos-inventario, AT-14 del inventario de
-- D-126).
--
-- Firmar la 002 es el alta (EN-130), y el art. 6 del A.M. 00115-2021 pone el
-- diagnóstico en el contenido mínimo. Hasta aquí sólo lo frenaba la pantalla:
-- un cliente de la API firmaba una nota sin diagnóstico, y el RDACAA recibía
-- una atención que no puede reportar. El servicio responde
-- `NOTE_CONTENT_INCOMPLETE`; esto lo garantiza ante cualquier otro camino.
--
-- Es la otra mitad de `encounter_diagnosis_last_after_discharge` (EN-188):
-- aquélla impide quitar el último diagnóstico tras el alta; ésta, llegar al
-- alta sin ninguno.
--
-- SÓLO CUANDO LA FIRMA DA EL ALTA, y por eso es un disparador DIFERIDO: se
-- comprueba al confirmar la transacción, cuando ya se sabe cómo terminó la
-- atención. Firmar la 002 desde la ruta de firma da el alta en el mismo acto;
-- interrumpir (EN-167) también firma la 002 con lo escrito, pero deja la
-- atención `DISCONTINUED` y no exige diagnóstico («obligaría a escribir algo
-- que no ocurrió»). Un disparador inmediato no distinguiría las dos.
--
-- SÓLO EL PASO DE BORRADOR A FIRMADA, no la fila que nace firmada. La enmienda
-- (EN-025) nace firmada, pero de una 002 que ya pasó por aquí y en una atención
-- que, tras el alta, no puede quedarse sin diagnóstico.
--
-- La 005 no lo exige: el art. 6 rige el contenido mínimo de la historia, y lo
-- cumple la 002.
--
-- No toca datos: en la copia de la base del autor (04-10-2026) las tres notas
-- 002 firmadas tenían diagnóstico.

CREATE FUNCTION clinical_note_sign_needs_diagnosis()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF encounter_has_discharge(NEW.encounter_id)
     AND NOT EXISTS (SELECT 1 FROM encounter_diagnosis d
                      WHERE d.encounter_id = NEW.encounter_id) THEN
    RAISE EXCEPTION
      'clinical_note_sign_needs_diagnosis: signing the consultation note discharges the attention, which needs at least one diagnosis'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-020.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_clinical_note_sign_needs_diagnosis
  AFTER UPDATE OF status ON clinical_note
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.status = 'DRAFT' AND NEW.status = 'SIGNED' AND NEW.form_code = '002')
  EXECUTE FUNCTION clinical_note_sign_needs_diagnosis();
