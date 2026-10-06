-- agenda_waitlist_patient_fixed
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- AG-063, AG-162 (revisión de `fix/menos-preguntas-agenda`, P1).
--
-- Desde D-127 el paciente de una cita se corrige en el sitio. La regla de
-- AG-063 —la cita que una entrada de la lista de espera tiene enlazada es del
-- MISMO paciente— sólo se comprobaba al escribir en `waitlist_entry`
-- (`waitlist_entry_conversion_is_consented`). Cambiar después el paciente de
-- la cita dejaba a quien esperaba con una entrada «agendada» que apunta a la
-- cita de otra persona, y sin forma de reabrirla.
--
-- Ahora la base lo rechaza también desde el otro lado: una cita enlazada desde
-- `waitlist_entry.converted_entry_id` no cambia de paciente. No toca ninguna
-- fila guardada: es un disparador sobre UPDATE.

CREATE OR REPLACE FUNCTION agenda_entry_waitlist_patient_is_fixed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "waitlist_entry" w WHERE w."converted_entry_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION
      'agenda_entry_waitlist_patient_fixed: an appointment given from the waiting list keeps its patient'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'agenda_entry_waitlist_patient_fixed',
            HINT = 'AG-063. Anule la cita y reserve una nueva para el otro paciente.';
  END IF;
  RETURN NEW;
END;
$$;

-- «emergency» < «record_version» < «waitlist» por orden alfabético: este
-- disparador corre el último, y lo que rechaza aborta la sentencia entera,
-- versión incluida.
CREATE TRIGGER "trg_agenda_entry_waitlist_patient_fixed"
  BEFORE UPDATE OF "patient_id" ON "agenda_entry"
  FOR EACH ROW
  WHEN (NEW."patient_id" IS DISTINCT FROM OLD."patient_id")
  EXECUTE FUNCTION agenda_entry_waitlist_patient_is_fixed();
