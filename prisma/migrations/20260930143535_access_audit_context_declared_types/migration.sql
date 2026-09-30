-- access_audit_context_declared_types
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- AG-073 · THE CONTEXT OF AN ACCESS IS A CLOSED LIST
--
-- `access_audit_context` let any text into `context_type`. An investigation
-- filters by `'agenda_entry'`, and a row written as `'cita'` or
-- `'Agenda_Entry'` by an import or a `psql` would silently fall out of it —
-- the same reason the payload columns carry a whitelist. Adding a context is
-- one line here and one in `AccessContext` (`shared/audit/access-audit.port.ts`).
--
-- Its own migration and not an edit of `access_audit_context`: that one is
-- already applied to the shared development database, and rewriting it would
-- force every session sharing that base through `db:reset`.
--
-- Después: pnpm migrations:check && pnpm db:deploy

ALTER TABLE "access_audit"
  ADD CONSTRAINT "access_audit_context_declared_types"
  CHECK ("context_type" IS NULL OR "context_type" IN ('agenda_entry'));
