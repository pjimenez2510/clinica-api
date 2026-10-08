-- encounter_never_deleted
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- ═══════════════════════════════════════════════════════════════════════════
-- EN-018: UNA ATENCIÓN NO SE BORRA, NI SIQUIERA VACÍA
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Las claves foráneas que apuntan a `encounter` son `ON DELETE RESTRICT`, así
-- que una atención con nota, diagnóstico o receta ya no se podía borrar. La
-- que sí se podía es la VACÍA —la que se abrió sobre la ficha equivocada y
-- nadie escribió nada—, y es justamente la que tiene que quedar: anularla
-- (EN-166) deja quién, cuándo y por qué; borrarla la saca del recuento de
-- producción del mes sin rastro.
--
-- LO QUE GARANTIZA: `DELETE` de cualquier fila de `encounter` y `TRUNCATE` de
-- la tabla (también el que llega en cascada desde otra) se rechazan con
-- `insufficient_privilege` y una pista que dice que se anule.
--
-- LO QUE NO RECHAZA, como `agenda_status_history` y `access_audit`: una sesión
-- en `session_replication_role = 'replica'`, que exige privilegios que la
-- aplicación no usa y es la puerta por la que la suite de integración limpia
-- entre pruebas.
--
-- El nombre va PRIMERO en el mensaje: es como `database-problem.ts` lee qué
-- regla saltó en un disparador.

CREATE FUNCTION encounter_never_deleted()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'encounter_never_deleted: an attention is never deleted (operation %)', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'An attention opened by mistake is annulled with who and when '
                 '(EN-018, EN-166): POST /encounters/:id/enter-in-error.';
END;
$$;

CREATE TRIGGER "trg_encounter_no_delete"
  BEFORE DELETE ON "encounter"
  FOR EACH ROW
  EXECUTE FUNCTION encounter_never_deleted();

-- TRUNCATE no dispara los disparadores por fila: necesita el suyo.
CREATE TRIGGER "trg_encounter_no_truncate"
  BEFORE TRUNCATE ON "encounter"
  FOR EACH STATEMENT
  EXECUTE FUNCTION encounter_never_deleted();
