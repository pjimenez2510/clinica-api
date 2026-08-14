-- access_audit_previous_value
--
-- Escrito a mano. `prisma migrate dev` está prohibido en este
-- repositorio: propone borrar las columnas generadas, los índices GIN y
-- BRIN, los índices únicos parciales y los disparadores, porque
-- schema.prisma no puede describirlos. Ver scripts/new-migration.mts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- D-017 · THE TRAIL SAYS FROM WHICH VALUE — AND ONLY WHERE THAT IS SAFE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS MISSING. AG-097 promises «quién cambió cada parámetro, cuándo y
-- desde qué valor» and CF-066 promises «autor, instante y valor anterior».
-- `access_audit` held the first two thirds and nothing held the last one, so
-- the log answered «who raised the overbooking cap and when» but not «from
-- what» — which is the half that reconstructs why an appointment was accepted
-- in March and an identical one refused in April.
--
-- WHY HERE AND NOT IN A TABLE OF ITS OWN. One trail, one mechanism, for every
-- module. A versions table per module answers the same question in a different
-- place each time, and «¿quién cambió la configuración de esta clínica?» stops
-- being one query the day a second module needs it.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY THE WHITELIST EXISTS, AND WHAT HAPPENS IF SOMEBODY ADDS A CLINICAL
-- RESOURCE TYPE TO IT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `access_audit` is written by EVERY module, including the one that records
-- each read of a patient's chart. A free-form «previous value» column here is
-- an open road for health data to land in the very table that exists to watch
-- who looks at it — and this table is append-only and never purged, so a row
-- written by mistake cannot be deleted, corrected or anonymised. It would also
-- invert the table's purpose: the register of accesses would become a second,
-- unreviewed copy of the record it protects, outside every retention and
-- minimisation rule the LOPDP imposes on clinical content.
--
-- So the payload is not allowed by convention — a convention that nothing can
-- enforce — but by this CHECK. Today the list is exactly `'configuration'`,
-- which is what `ConfigurationAuditTrail` writes for holidays and site
-- parameters: a date, a name, a scope, four numbers and two flags. No PHI is
-- reachable from any of them.
--
-- ADDING A RESOURCE TYPE TO THIS LIST IS A DECISION ABOUT PERSONAL DATA, not a
-- schema tweak. `'patient'`, `'encounter'`, `'clinical_note'`, `'certificate'`
-- and anything else naming clinical content MUST NOT be added: the moment one
-- is, every module writing that type may deposit the record's own contents
-- here, permanently, and the guarantee this migration exists to give is gone
-- with no way to walk it back. A module that genuinely needs versioned
-- clinical content needs its own decision and its own storage, with its own
-- retention — not a line in this list.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- COST
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Both columns are NULL in the overwhelming majority of rows, because the
-- overwhelming majority of rows are READs. A NULL in PostgreSQL is a bit in
-- the row's null bitmap and occupies NO space in the tuple, so the two columns
-- cost nothing on the rows that do not use them. `ADD COLUMN` without a
-- default is metadata-only too: no table rewrite, no downtime.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- COEXISTENCE WITH THE APPEND-ONLY TRIGGERS
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `trg_access_audit_immutable` fires BEFORE UPDATE OR DELETE **FOR EACH ROW**
-- and `trg_access_audit_no_truncate` before TRUNCATE. Neither fires for
-- `ALTER TABLE`: DDL does not go through row triggers, and `ADD COLUMN`
-- without a default touches only the catalog. The CHECK is validated by a
-- read-only scan of existing rows — all of which have both columns NULL and
-- therefore satisfy it — so this migration applies without disabling anything.
-- The two guarantees stay independent and both hold: the payload cannot land
-- where it must not, and once landed it cannot be edited.
--
-- Después: pnpm migrations:check && pnpm db:deploy

ALTER TABLE "access_audit"
  ADD COLUMN "before" JSONB,
  ADD COLUMN "after"  JSONB;

COMMENT ON COLUMN "access_audit"."before" IS
  'Estado del recurso ANTES de la mutación (AG-097, CF-066). Nulo en las '
  'lecturas y en todo tipo de recurso que no figure en '
  'access_audit_payload_only_for_declared_resources.';

COMMENT ON COLUMN "access_audit"."after" IS
  'Estado del recurso DESPUÉS de la mutación (AG-097, CF-066). Nulo cuando el '
  'recurso desapareció, y en todo tipo de recurso no declarado.';

ALTER TABLE "access_audit"
  ADD CONSTRAINT "access_audit_payload_only_for_declared_resources"
  CHECK (
    ("before" IS NULL AND "after" IS NULL)
    OR "resource_type" IN ('configuration')
  );

COMMENT ON CONSTRAINT "access_audit_payload_only_for_declared_resources"
  ON "access_audit" IS
  'D-017. Lista blanca de tipos de recurso que pueden llevar valor anterior y '
  'posterior. La historia clínica NO está en la lista, y añadirla convertiría '
  'la bitácora de accesos en una copia permanente e imborrable del contenido '
  'que vigila.';
