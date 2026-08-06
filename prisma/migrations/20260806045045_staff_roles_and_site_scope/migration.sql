-- Roles held by a user, scoped to a site or granted globally. See ADR-007.
--
-- ⚠️ THIS FILE WAS EDITED AFTER GENERATION, AND HAD TO BE.
-- `prisma migrate dev` produced a migration that also dropped
-- `patient.search_name`, `catalog_concept.search_display`,
-- `catalog_concept.valid_period`, both trigram indexes, the BRIN index on
-- `access_audit` and `clinical_note_chain_version_unique` — every object that
-- exists in SQL and not in schema.prisma. Prisma cannot see them, so it reads
-- them as drift and removes them.
--
-- Applying it unedited would have silently destroyed accent-insensitive
-- patient search and the temporal validity of the CIE-10 catalogue. Those
-- DROP statements are removed below; only the additive ones remain.
--
-- This is the same reason `prisma db push` is forbidden in this project, and
-- the reason the CI job asserts the guarantees still exist after migrating.

-- CreateEnum
CREATE TYPE "staff_role" AS ENUM ('ADMIN', 'MEDICO', 'ENFERMERIA', 'RECEPCION', 'CAJA', 'AUDITOR');

-- CreateTable
CREATE TABLE "user_role_grant" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "role" "staff_role" NOT NULL,
    "site_id" UUID,
    "granted_by_id" UUID,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "user_role_grant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_role_grant_user_id_revoked_at_idx" ON "user_role_grant"("user_id", "revoked_at");

-- AddForeignKey
ALTER TABLE "user_role_grant" ADD CONSTRAINT "user_role_grant_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_grant" ADD CONSTRAINT "user_role_grant_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role_grant" ADD CONSTRAINT "user_role_grant_granted_by_id_fkey" FOREIGN KEY ("granted_by_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- Guarantees Prisma cannot express
-- ===========================================================================

-- The same role cannot be granted twice while it is still in force.
--
-- `NULLS NOT DISTINCT` is the whole point, and it is PostgreSQL 15+. Without
-- it, NULL site_id values compare as distinct, so a user could accumulate any
-- number of identical GLOBAL grants — precisely the assignment that carries
-- the most authority. Partial on `revoked_at IS NULL` so a role can be
-- granted again after being revoked, which is an ordinary thing to happen.
CREATE UNIQUE INDEX user_role_grant_active_unique
  ON user_role_grant (user_id, role, site_id) NULLS NOT DISTINCT
  WHERE revoked_at IS NULL;

-- A revocation cannot precede the grant.
ALTER TABLE user_role_grant
  ADD CONSTRAINT user_role_grant_revocation_order
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at);

-- Nobody grants themselves a role. The audit question "who gave this person
-- access to clinical records" must never answer "they did".
ALTER TABLE user_role_grant
  ADD CONSTRAINT user_role_grant_no_self_grant
  CHECK (granted_by_id IS NULL OR granted_by_id <> user_id);

-- A grant is revoked, never deleted: who could do what, and when, is part of
-- the audit trail. Same mechanism that already protects the access log and
-- signed clinical notes.
CREATE OR REPLACE FUNCTION user_role_grant_no_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'role grants are revoked, never deleted (operation %)', TG_OP
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Set revoked_at instead. The history of who held which role '
                 'is part of the audit trail.';
END;
$$;

CREATE TRIGGER trg_user_role_grant_no_delete
  BEFORE DELETE ON user_role_grant
  FOR EACH ROW
  EXECUTE FUNCTION user_role_grant_no_delete();

CREATE TRIGGER trg_user_role_grant_no_truncate
  BEFORE TRUNCATE ON user_role_grant
  FOR EACH STATEMENT
  EXECUTE FUNCTION user_role_grant_no_delete();

COMMENT ON TABLE user_role_grant IS
  'Roles held by a user, scoped to a site or global (site_id NULL). '
  'Revoked, never deleted. See ADR-007.';
