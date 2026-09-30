-- access_audit_context
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- AG-073 · THE TRAIL SAYS FROM WHERE A CHART WAS OPENED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS MISSING. AG-073 promises «quién, qué, cuándo y desde dónde» for a
-- chart opened from the agenda. The row already carried who, what, when, the
-- IP and the user agent; nothing said the chart was reached FROM AN
-- APPOINTMENT. «¿Quién abrió esta ficha sin tener cita con ella?» is the
-- question an improper-access investigation asks first, and without the
-- context it has no answer.
--
-- WHY IN THE SAME ROW. FHIR `AuditEvent.entity` and IHE BALP record one event
-- naming both the resource read and the one it was reached from. Two rows
-- related only by their timestamps come apart as soon as somebody has two tabs
-- open.
--
-- WHY IDENTIFIERS ONLY. Same line as `access_audit_payload_only_for_declared_
-- resources`: this table is append-only and never purged, so nothing that
-- describes a patient may land in it. A context is a type and an id, never a
-- snapshot.
--
-- BOTH OR NEITHER, checked by the base. A type with no id is an assertion
-- nobody can follow, and an id with no type cannot be resolved.
--
-- COST. Both NULL on almost every row: a NULL lives in the null bitmap, and
-- `ADD COLUMN` without a default is metadata-only. The CHECK scans existing
-- rows, all NULL in both, so it validates without disabling the append-only
-- triggers — row triggers do not fire for DDL.
--
-- Después: pnpm migrations:check && pnpm db:deploy

ALTER TABLE "access_audit"
  ADD COLUMN "context_type" VARCHAR(64),
  ADD COLUMN "context_id"   VARCHAR(64);

ALTER TABLE "access_audit"
  ADD CONSTRAINT "access_audit_context_both_or_neither"
  CHECK (("context_type" IS NULL) = ("context_id" IS NULL));

COMMENT ON COLUMN "access_audit"."context_type" IS
  'AG-073. Desde qué tipo de recurso se llegó al acceso (hoy, agenda_entry). '
  'Nulo cuando el acceso no se hizo desde otro recurso.';

COMMENT ON COLUMN "access_audit"."context_id" IS
  'AG-073. Identificador del recurso desde el que se llegó. Va con '
  'context_type o no va.';
