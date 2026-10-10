-- encounter_procedure_performed_within_encounter
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-247 (revisión clínica de la rama, G1): EL PROCEDIMIENTO REGISTRADO TRAS
-- EL ALTA SE HIZO DURANTE LA ATENCIÓN, NO CUANDO SE TECLEA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. Antes de D-194.1 un procedimiento sólo se registraba con la atención
--    viva, y «ahora» era su hora real. Tras el alta ya no: registrado el
--    12-10 el de una atención del 09-10, «ahora» pondría en la historia, en
--    la firma del 024 y en la fecha de servicio del cargo un día que no fue.
--    `encounter_procedure_performed_within_encounter`: al registrar en una
--    atención que ya terminó (`ended_at`), la hora de realización está entre
--    su inicio y su fin. Sólo al INSERT: lo ya registrado no se reescribe, y
--    una atención viva no tiene fin todavía.
--
-- 2. `recorded_at`, cuándo se registró la fila (el reloj de la aplicación):
--    lo que caja necesita para ver que un procedimiento llegó DESPUÉS de
--    liquidar la cuenta (BI-242, como BI-194 con los exámenes). Nulo en lo
--    registrado antes de esta migración: ese dato no está en ninguna parte y
--    no se inventa.

ALTER TABLE "encounter_procedure" ADD COLUMN "recorded_at" TIMESTAMPTZ(6);

CREATE FUNCTION encounter_procedure_performed_within_encounter()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  attention encounter%ROWTYPE;
BEGIN
  SELECT * INTO attention FROM encounter WHERE id = NEW.encounter_id;
  IF attention.ended_at IS NOT NULL
     AND (NEW.performed_at < attention.started_at
          OR NEW.performed_at > attention.ended_at) THEN
    RAISE EXCEPTION
      'encounter_procedure_performed_within_encounter: a procedure recorded after the attention ended was performed during it'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-247.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_procedure_admits_within_encounter"
  BEFORE INSERT ON "encounter_procedure"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_procedure_performed_within_encounter();
