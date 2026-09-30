-- auth_session_epoch
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- Explique QUÉ garantiza este cambio y POR QUÉ, no sólo qué hace.
-- Después: pnpm migrations:check && pnpm db:deploy

-- QUÉ GARANTIZA: AU-041. Un inicio de sesión que coincide con el cierre de
-- todas las sesiones de la cuenta —cambio de contraseña, desactivación
-- (AU-023), reinicio del segundo factor (AU-036), canje de una invitación— no
-- deja viva la sesión que emite.
--
-- POR QUÉ UNA COLUMNA. El inicio de sesión lee la cuenta, gasta ~100 ms de
-- Argon2 y emite la familia. Un cierre confirmado en medio no la veía: aún no
-- existía. `session_epoch` cuenta cuántas veces se han cerrado todas las
-- sesiones de la cuenta; `revokeLiveSessions` la incrementa como primera
-- sentencia, y la emisión la compara con la leída junto a las credenciales,
-- con la fila de la cuenta bloqueada FOR SHARE. Un contador y no un instante:
-- la comparación es de igualdad y no tiene empates de reloj.
--
-- NOT NULL DEFAULT 0: las cuentas existentes empiezan en la misma época, y
-- ninguna sesión viva se cierra por aplicar esta migración.

ALTER TABLE app_user
  ADD COLUMN session_epoch integer NOT NULL DEFAULT 0;
