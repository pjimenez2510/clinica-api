-- encounter_status_history_only_from_the_trigger
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- EN-133: EL HISTORIAL DE ESTADOS SÓLO LO ESCRIBE SU DISPARADOR
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `encounter_status_history_immutable` impedía editar y borrar, pero no
-- AÑADIR: un `INSERT` directo bien formado —«dada de alta por X» sobre una
-- atención que sigue abierta— entraba sin error y falseaba quién y qué. Una
-- constancia en la que cualquiera puede escribir una fila de más no es una
-- constancia (revisión clínica de `feat/f04-atencion-y-nota`).
--
-- LO QUE GARANTIZA:
--   · Sólo entra una fila escrita desde `encounter_status_history_record`,
--     es decir, desde dentro de otro disparador: `pg_trigger_depth()` es 1
--     en una sentencia directa y 2 en el INSERT que hace el disparador de
--     `encounter`.
--   · Y la fila dice el estado que la atención TIENE: `to_status` igual al
--     `status` de la atención en ese momento (el AFTER ya lo ve escrito).
--
-- Como los demás, no lo detiene una sesión en `session_replication_role =
-- 'replica'`; esa puerta es la de la suite de pruebas y la de un superusuario.

CREATE FUNCTION encounter_status_history_only_from_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION
      'encounter_status_history_written_by_trigger: the state trail of an attention is written only by the database when the state changes'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'EN-133: change encounter.status and the trail follows.';
  END IF;
  IF NEW."to_status" IS DISTINCT FROM
     (SELECT e."status" FROM "encounter" e WHERE e."id" = NEW."encounter_id") THEN
    RAISE EXCEPTION
      'encounter_status_history_written_by_trigger: the row does not match the state of the attention'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'EN-133.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_encounter_status_history_insert_guard"
  BEFORE INSERT ON "encounter_status_history"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_status_history_only_from_trigger();

-- CORRECCIÓN AL COMENTARIO DE `encounter_status_history`: decía que el cierre
-- de la cuenta sobrescribe lo que el alta dejó escrito. No es así: firmar la
-- 002 no escribe `closed_by_id`; el firmante queda en `clinical_note` y no
-- cambia. Reconstruir el historial de las atenciones anteriores es posible
-- salvo quién abrió, y es D-177.4 del autor.
