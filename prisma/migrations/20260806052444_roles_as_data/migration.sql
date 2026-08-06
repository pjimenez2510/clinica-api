-- Roles become DATA. See ADR-007 (revised).
--
-- The previous design modelled roles as a PostgreSQL enum and the role →
-- permission mapping as a constant in TypeScript. Both were wrong: a clinic
-- that hires an external auditor, splits nursing into ward and outpatient, or
-- takes on a health-insurance liaison should not need a migration and a
-- deploy. Only the CATALOGUE of permissions stays anchored to the code,
-- because a permission means nothing unless some route checks it.
--
-- ⚠️ EDITED AFTER GENERATION, for the second time. `prisma migrate dev` again
-- emitted DROP statements for `patient.search_name`,
-- `catalog_concept.search_display`, `catalog_concept.valid_period`, both
-- trigram indexes, the BRIN index on the audit log and
-- `clinical_note_chain_version_unique`. This is systematic, not bad luck: it
-- will happen on every future migration, because Prisma cannot see objects
-- that exist only in SQL. `pnpm migrations:check` now fails on exactly this.

-- The enum column goes; the FK replaces it. There is no data to migrate: no
-- grant has ever been issued.
ALTER TABLE "user_role_grant" DROP COLUMN "role";
ALTER TABLE "user_role_grant" ADD COLUMN "role_id" UUID NOT NULL;
DROP TYPE "staff_role";

CREATE TABLE "permission" (
    "code" VARCHAR(64) NOT NULL,
    "resource" VARCHAR(32) NOT NULL,
    "description" VARCHAR(255) NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "role" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(48) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "role_permission" (
    "role_id" UUID NOT NULL,
    "permission_code" VARCHAR(64) NOT NULL,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by_id" UUID,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission_code")
);

CREATE INDEX "permission_resource_idx" ON "permission"("resource");
CREATE UNIQUE INDEX "role_code_key" ON "role"("code");
CREATE INDEX "user_role_grant_role_id_idx" ON "user_role_grant"("role_id");

ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "permission"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "user_role_grant" ADD CONSTRAINT "user_role_grant_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Guarantees Prisma cannot express
-- ===========================================================================

-- The active-grant uniqueness has to be rebuilt: it named the enum column.
DROP INDEX IF EXISTS user_role_grant_active_unique;
CREATE UNIQUE INDEX user_role_grant_active_unique
  ON user_role_grant (user_id, role_id, site_id) NULLS NOT DISTINCT
  WHERE revoked_at IS NULL;

-- A role code is an identifier, not a label: it appears in seeds, logs and
-- support conversations. Lowercase or spaced codes make those unsearchable.
ALTER TABLE "role"
  ADD CONSTRAINT role_code_shape CHECK (code ~ '^[A-Z][A-Z0-9_]{2,47}$');

-- A system role is never deleted. Deleting the last role that can manage users
-- locks everyone out of the system, including whoever would undo it — and the
-- FK from user_role_grant is RESTRICT, so it would fail confusingly anyway.
CREATE OR REPLACE FUNCTION role_protect_system()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.is_system THEN
    RAISE EXCEPTION 'system role % cannot be deleted', OLD.code
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Deactivate it instead, or edit its permissions.';
  END IF;

  -- Renaming the code breaks every seed and every log line that refers to it.
  IF TG_OP = 'UPDATE' AND OLD.is_system AND NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'the code of system role % cannot be changed', OLD.code
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Change the display name; the code is an identifier.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_role_protect_system
  BEFORE UPDATE OR DELETE ON "role"
  FOR EACH ROW
  EXECUTE FUNCTION role_protect_system();

-- Someone must always be able to manage users.
--
-- Not expressible as a CHECK: it spans rows and tables. A statement-level
-- trigger is the only place it can live, and it has to live somewhere — the
-- alternative is a clinic that revokes one permission too many on a Friday and
-- cannot get back in.
CREATE OR REPLACE FUNCTION role_permission_keep_an_administrator()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM role_permission rp
      JOIN "role" r ON r.id = rp.role_id
     WHERE rp.permission_code = 'user:manage'
       AND r.active
  ) THEN
    RAISE EXCEPTION 'at least one active role must keep user:manage'
      USING ERRCODE = 'integrity_constraint_violation',
            HINT = 'Grant it to another role before removing it from this one.';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER trg_role_permission_keep_admin
  AFTER DELETE OR UPDATE ON role_permission
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION role_permission_keep_an_administrator();

COMMENT ON TABLE "role" IS
  'Roles as data: a clinic adds one without a deploy. System roles ship with '
  'the product and cannot be deleted, but their permissions are editable.';
COMMENT ON TABLE permission IS
  'Mirror of the permission catalogue defined in code. A permission only '
  'protects something if a route checks it, so this table is seeded from the '
  'code and a test asserts the two agree.';
