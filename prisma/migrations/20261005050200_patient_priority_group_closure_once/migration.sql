-- PA-037. Un registro de grupo prioritario se cierra una sola vez
-- (fix/fallos-inventario, PA-14 del inventario de D-126).
--
-- Cerrar dos veces sobrescribía `closed_by`, `closed_at` y `ends_on` sin
-- dejar rastro del primer cierre, que es justo lo que PA-039 guarda. El
-- servicio ya responde `PRIORITY_GROUP_ALREADY_CLOSED`; esto es lo que lo
-- garantiza también ante un `psql` o una importación.
--
-- «Cerrado» es tener `closed_at`, no `ends_on`: el embarazo nace con fin
-- (PA-036). Corregir un cierre equivocado será la edición con versión de
-- D-127, que tendrá que contar con este disparador.
--
-- No toca datos: en la copia de la base del autor (04-10-2026) no había
-- ningún registro cerrado.

CREATE FUNCTION patient_priority_group_closure_once()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.closed_at IS NOT NULL
     AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at
          OR NEW.closed_by IS DISTINCT FROM OLD.closed_by
          OR NEW.ends_on IS DISTINCT FROM OLD.ends_on) THEN
    RAISE EXCEPTION
      'patient_priority_group_closure_once: a closed record keeps its first closure'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'PA-037, PA-039.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_patient_priority_group_closure_once
  BEFORE UPDATE OF closed_at, closed_by, ends_on ON patient_priority_group
  FOR EACH ROW
  EXECUTE FUNCTION patient_priority_group_closure_once();
