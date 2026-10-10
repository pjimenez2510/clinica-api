-- encounter_procedure_after_discharge
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- EN-247 (D-194.1): EL PROCEDIMIENTO SE CORRIGE TRAS EL ALTA, NUNCA REPORTADO
-- EN-152, EN-153 (D-199.4): QUIEN INFORMÓ EL 024 ES UN PROFESIONAL DE LA SEDE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 1. D-194.1 abre registrar, corregir y quitar un procedimiento tras el alta,
--    con la regla de los diagnósticos (D-117.13, `record:sign` y licencia: del
--    servicio, la base no conoce la sesión). Lo que la base sí puede decir es
--    D-117.16: una atención ya reportada al RDACAA no cambia sus columnas 95 a
--    100, porque nada la reenvía. `encounter_procedure_reported` lo rechaza al
--    registrar o corregir la fila viva y al archivarla para quitarla, como
--    `encounter_diagnosis_reported` hace con el diagnóstico.
--
-- 2. D-199.4: quien informó es el profesional que interviene —propuesto el de
--    la atención— y no quien teclea. `procedure_consent_informer_at_site`
--    admite al profesional de la atención, o a un profesional ACTIVO asignado
--    a la sede de la atención (`practitioner_site`). Mira sólo el alta de la
--    fila: el 024 no se edita, y un profesional que después deja la sede no
--    invalida lo que informó.
--
-- Ninguna fila guardada se toca, y ningún `now()`.

-- ── 1. D-117.16: la atención reportada no se corrige ──────────────────────
-- El nombre va PRIMERO en el mensaje: es como `database-problem.ts` lee qué
-- regla saltó en un disparador.
CREATE FUNCTION encounter_procedure_reported_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF encounter_is_reported(NEW.encounter_id) THEN
    RAISE EXCEPTION
      'encounter_procedure_reported: the attention was already reported to the RDACAA, and a correction would not reach it'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-247, D-117.16.';
  END IF;
  RETURN NEW;
END;
$$;

-- «admits» antes que «record_version» (orden alfabético de los BEFORE): lo
-- que se rechaza no llega a archivar nada.
CREATE TRIGGER "trg_encounter_procedure_admits_unreported"
  BEFORE INSERT OR UPDATE ON "encounter_procedure"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_procedure_reported_admits();

-- Quitar es archivar y después borrar: con el archivo cerrado, tampoco se
-- borra (`trg_encounter_procedure_delete_archived` exige el archivo).
CREATE TRIGGER "trg_encounter_procedure_retraction_admits_unreported"
  BEFORE INSERT ON "encounter_procedure_retraction"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_procedure_reported_admits();

-- ── 2. D-199.4: quien informó, de la sede ─────────────────────────────────
CREATE FUNCTION procedure_consent_informer_at_site(p_encounter_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM encounter e
      JOIN practitioner p ON p.user_id = p_user_id
     WHERE e.id = p_encounter_id
       AND (
         p.id = e.practitioner_id
         OR (p.active AND EXISTS (SELECT 1 FROM practitioner_site ps
                                   WHERE ps.practitioner_id = p.id
                                     AND ps.site_id = e.site_id))
       )
  );
$$;

CREATE FUNCTION procedure_consent_informer_admits()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.informed_by_id IS NOT NULL
     AND NOT procedure_consent_informer_at_site(NEW.encounter_id, NEW.informed_by_id) THEN
    RAISE EXCEPTION
      'procedure_consent_informer_at_site: who informed is the attention''s professional or an active professional of its site'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'EN-152, EN-153, D-199.4.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_procedure_consent_informer_admits"
  BEFORE INSERT ON "procedure_consent"
  FOR EACH ROW
  EXECUTE FUNCTION procedure_consent_informer_admits();
