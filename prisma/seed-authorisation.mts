import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { DEFAULT_ROLES } from '../src/modules/auth/domain/default-roles.ts';
// `PERMISSION_DEFINITIONS` and not the raw catalogue: `permission` has three
// columns, and handing Prisma the constant verbatim broke the moment an entry
// grew an internal field (`explicitGrantOnly`). The projection is the shape of
// the table, stated in one place.
import { PERMISSION_DEFINITIONS } from '../src/shared/authorisation/permission.catalogue.ts';

/**
 * Grants that D-012's third rule CANNOT deliver, and the only reason they are
 * written by hand.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A LIST AT ALL, WHEN `DEFAULT_ROLES` ALREADY DECLARES THEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * D-012 grants a permission to the system roles that declare it ONLY WHEN THE
 * CODE IS BRAND NEW, and that narrowness is the whole safety argument: a code
 * nobody could ever have revoked is one where there is no human decision to
 * overwrite. These two codes are not new — they have existed since 16-08-2026
 * and 19-08-2026 — so on any database older than the decision the sync would
 * report success and change nothing, and the decision would exist in the code
 * and in no installation.
 *
 * WHY IT IS SAFE HERE, AND ONLY HERE: until 19-08-2026 both codes carried
 * `explicitGrantOnly`, which means NO SEED EVER HANDED THEM OUT. Their absence
 * from a role is therefore not a revocation anybody made — it is the state the
 * code imposed. That is exactly the property D-012 needs and cannot infer,
 * because the catalogue does not remember what it used to say.
 *
 * ⚠️ WHAT IT COSTS: an installation where somebody granted one of these by
 * hand and then took it away gets it back once. There is no way to tell that
 * apart from «never granted» without a history the tables do not keep, and the
 * decision of 19-08-2026 is that these two roles carry them.
 *
 * ⚠️ THIS LIST IS ONE-OFF AND DATED. It can be deleted once no database
 * predates 19-08-2026 — for a fresh installation it is already redundant,
 * since the roles are created from `DEFAULT_ROLES` with the codes in them.
 * Do NOT grow it into the general mechanism: the general mechanism is D-012,
 * and widening that one is how a permission a clinic revoked comes back.
 */
const BACKFILL_19_08_2026: readonly { role: string; permission: string }[] = [
  { role: 'MEDICO', permission: 'patient:priority:protected' },
  { role: 'MEDICO', permission: 'patient:sexual-orientation' },
  { role: 'ADMIN', permission: 'patient:priority:protected' },
  { role: 'ADMIN', permission: 'patient:sexual-orientation' },
];

/**
 * Brings the authorisation tables in line with the code.
 *
 * Runs in EVERY environment, unlike the development seed: the permission
 * catalogue is part of the code's contract, and a production database without
 * it cannot grant anything.
 *
 * Three rules keep this from trampling a clinic's configuration:
 *
 *   - Permissions are upserted. The code decides which exist and what they are
 *     called, so a renamed description propagates.
 *   - Roles are created ONLY IF ABSENT, and their permissions only on
 *     creation. A clinic that removed `catalog:read` from Recepción meant it;
 *     a deploy that silently put it back would be a bug that looks like magic.
 *   - A permission code that DID NOT EXIST BEFORE this sync is granted to the
 *     system roles whose definition declares it (D-012).
 *
 * THE THIRD RULE IS NARROW ON PURPOSE, and the narrowness is what makes it
 * safe. Without it a new feature ships unreachable: the permission exists, no
 * role holds it, and the screen that would grant it is itself behind a
 * permission. That happened with `config:*` and left the administrator locked
 * out of a screen that had just been built.
 *
 * Granting only BRAND-NEW codes is what keeps the second rule intact: a code
 * that never existed cannot have been revoked by anybody, so there is no human
 * decision to overwrite. One the clinic removed stays removed forever. *
 * Beside the three, one-off grants that D-012 cannot deliver: the dated list
 * above, and AU-042's, which is remembered in `authorisation_one_off` and so
 * happens once per database (`grantBackgroundWriteOnce`).
 */
export async function syncAuthorisation(prisma: PrismaClient): Promise<{
  permissions: number;
  rolesCreated: string[];
  orphanPermissions: string[];
  /** `ROLE → permission` granted because the code is new (D-012). */
  grantedToSystemRoles: string[];
  /** `ROLE → permission` granted by the dated list above, and nothing else. */
  backfilled: string[];
  /** `ROLE → permission` granted by a one-off of AU-042, on its first run only. */
  grantedOnce: string[];
}> {
  // Read BEFORE upserting: afterwards every code exists and «new» is no
  // longer answerable. This snapshot is the whole basis of D-012's third rule.
  const codesBefore = new Set(
    (await prisma.permission.findMany({ select: { code: true } })).map(
      (permission) => permission.code,
    ),
  );

  // One transaction: a failure halfway through left the catalogue partially
  // synced, and a partially synced catalogue is one where a role references a
  // permission that does not exist yet.
  await prisma.$transaction(
    PERMISSION_DEFINITIONS.map((permission) =>
      prisma.permission.upsert({
        where: { code: permission.code },
        update: {
          resource: permission.resource,
          description: permission.description,
        },
        create: permission,
      }),
    ),
  );

  // A permission in the database that the code no longer checks grants nothing
  // and protects nothing, but it stays assignable in the admin screen — where
  // it reads as a promise the system does not keep. It is REPORTED, not
  // deleted: a role may still reference it, and deleting it during a deploy
  // would fail on the foreign key at the worst moment.
  const stored = await prisma.permission.findMany({ select: { code: true } });
  const known = new Set<string>(PERMISSION_DEFINITIONS.map((p) => p.code));
  const orphanPermissions = stored
    .map((p) => p.code)
    .filter((code) => !known.has(code));

  const rolesCreated: string[] = [];
  for (const role of DEFAULT_ROLES) {
    const existing = await prisma.role.findUnique({
      where: { code: role.code },
      select: { id: true },
    });
    if (existing) continue;

    await prisma.role.create({
      data: {
        code: role.code,
        name: role.name,
        description: role.description,
        isSystem: true,
        permissions: {
          create: role.permissions.map((permissionCode) => ({
            permissionCode,
          })),
        },
      },
    });
    rolesCreated.push(role.code);
  }

  /**
   * D-012: the codes that did not exist a moment ago reach the system roles
   * that declare them. A role just created already has them, so this only ever
   * touches roles that survived from a previous deploy.
   *
   * `createMany` with `skipDuplicates` and not an upsert: if the grant is
   * somehow already there, leaving it exactly as it is beats rewriting it.
   */
  const grantedToSystemRoles: string[] = [];
  const brandNew = PERMISSION_DEFINITIONS.map((p) => p.code).filter(
    (code) => !codesBefore.has(code),
  );

  if (brandNew.length > 0) {
    for (const role of DEFAULT_ROLES) {
      if (rolesCreated.includes(role.code)) continue;

      const missing = role.permissions.filter((code) =>
        brandNew.includes(code),
      );
      if (missing.length === 0) continue;

      const stored = await prisma.role.findUnique({
        where: { code: role.code },
        select: { id: true, isSystem: true },
      });
      // Only roles the CODE owns. One the clinic created with the same code is
      // its own, and this has no business writing into it.
      if (!stored?.isSystem) continue;

      await prisma.rolePermission.createMany({
        data: missing.map((permissionCode) => ({
          roleId: stored.id,
          permissionCode,
        })),
        skipDuplicates: true,
      });
      grantedToSystemRoles.push(
        ...missing.map((code) => `${role.code} → ${code}`),
      );
    }
  }

  /**
   * The dated one-off above. Only roles the CODE owns, and only roles that
   * survived from a previous deploy: one just created already carries the
   * codes, because `DEFAULT_ROLES` declares them.
   */
  const backfilled: string[] = [];
  for (const grant of BACKFILL_19_08_2026) {
    if (rolesCreated.includes(grant.role)) continue;

    const role = await prisma.role.findUnique({
      where: { code: grant.role },
      select: { id: true, isSystem: true },
    });
    if (!role?.isSystem) continue;

    const written = await prisma.rolePermission.createMany({
      data: [{ roleId: role.id, permissionCode: grant.permission }],
      skipDuplicates: true,
    });
    if (written.count > 0) {
      backfilled.push(`${grant.role} → ${grant.permission}`);
    }
  }

  return {
    permissions: PERMISSION_DEFINITIONS.length,
    rolesCreated,
    orphanPermissions,
    grantedToSystemRoles,
    backfilled,
    grantedOnce: await grantBackgroundWriteOnce(prisma),
  };
}

/**
 * AU-042, D-062 point 2: `background:write` reaches EVERY role that holds
 * `record:write` — the clinic's own roles too — once per database.
 *
 * The allergy and history routes moved from `record:write` to
 * `background:write` in `feat/f03-preparacion`. D-012 handed the new code to
 * the system roles only, so a clinic's own role that recorded allergies lost
 * that on deploy. D-012's argument covers this one too: holding `record:write`
 * already meant recording allergies, so nobody decided to take it away.
 *
 * ONCE, and the row in `authorisation_one_off` is what makes it once. It is
 * claimed in the same transaction as the grant, so two syncs at the same time
 * grant once; and a role the clinic later strips of `background:write` keeps
 * it stripped, which is exactly what `BACKFILL_19_08_2026` cannot promise.
 */
const BACKGROUND_WRITE_ONE_OFF = 'background-write-to-record-writers';

async function grantBackgroundWriteOnce(
  prisma: PrismaClient,
): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.authorisationOneOff.createMany({
      data: [{ name: BACKGROUND_WRITE_ONE_OFF }],
      skipDuplicates: true,
    });
    if (claimed.count === 0) return [];

    const writers = await tx.role.findMany({
      where: {
        permissions: { some: { permissionCode: 'record:write' } },
        NOT: { permissions: { some: { permissionCode: 'background:write' } } },
      },
      select: { id: true, code: true },
      orderBy: { code: 'asc' },
    });
    await tx.rolePermission.createMany({
      data: writers.map((role) => ({
        roleId: role.id,
        permissionCode: 'background:write',
      })),
      skipDuplicates: true,
    });
    return writers.map((role) => `${role.code} → background:write`);
  });
}

/** Entry point for `pnpm db:seed:auth`. */
async function main(): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const result = await syncAuthorisation(prisma);
    console.log(
      `Permissions synced: ${result.permissions}. ` +
        `Roles created: ${result.rolesCreated.join(', ') || 'none (already present)'}.`,
    );
    // Se informa SIEMPRE de lo concedido: un permiso que aparece solo tiene
    // que dejar rastro, o la próxima auditoría no sabrá de dónde salió.
    if (result.grantedToSystemRoles.length > 0) {
      console.log(
        `Permisos nuevos concedidos a roles del sistema (D-012): ${result.grantedToSystemRoles.join(', ')}.`,
      );
    }
    // Lo mismo para la lista fechada: si concede algo, se ve.
    if (result.backfilled.length > 0) {
      console.log(
        `Permisos repartidos por la decisión del 19-08-2026 (D-034, D-039): ${result.backfilled.join(', ')}.`,
      );
    }
    if (result.grantedOnce.length > 0) {
      console.log(
        `Permisos concedidos una sola vez a quien tenía record:write (AU-042, D-062): ${result.grantedOnce.join(', ')}.`,
      );
    }
    if (result.orphanPermissions.length > 0) {
      console.warn(
        `⚠️  Permissions in the database that the code no longer checks: ${result.orphanPermissions.join(', ')}.\n` +
          '   They are assignable in the admin screen and protect nothing. Remove them once no role references them.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

// Only when invoked directly, so importing `syncAuthorisation` from the
// development seed does not connect twice.
if (process.argv[1]?.endsWith('seed-authorisation.mts')) {
  await main();
}
