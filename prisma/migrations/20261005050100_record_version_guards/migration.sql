-- record_version_guards
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- EN-210, revisión de `fix/menos-preguntas`.
--
-- 1. TRUNCATE no dispara los disparadores por fila, así que
--    `trg_record_version_insert_only` no lo frena: la historia se podía vaciar
--    de un golpe. Las demás tablas de solo inserción ya lo cierran
--    (`agenda_status_history`, `access_audit`, `clinical_note`).
--
-- 2. Lo que el disparador de versiones NO garantiza, dicho donde vive: exige
--    que cada edición traiga un sello NUEVO (un instante distinto) y un autor,
--    pero no puede saber si ese autor es quien de verdad ejecuta el UPDATE. Un
--    psql que solo cambie `corrected_at` atribuye la edición al último que
--    corrigió. La API siempre sella con el usuario de la sesión; fuera de ella,
--    el autor es lo que diga quien escribe. Cerrarlo pide una identidad de
--    sesión en la base (`SET LOCAL app.user_id`), que este sistema aún no
--    tiene.

CREATE TRIGGER trg_record_version_no_truncate
  BEFORE TRUNCATE ON "record_version"
  FOR EACH STATEMENT
  EXECUTE FUNCTION record_version_insert_only();
