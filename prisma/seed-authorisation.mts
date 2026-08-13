import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { DEFAULT_ROLES } from '../src/modules/auth/domain/default-roles.ts';
import { PERMISSION_CATALOGUE } from '../src/shared/authorisation/permission.catalogue.ts';

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
 * decision to overwrite. One the clinic removed stays removed forever.
 */
export async function syncAuthorisation(prisma: PrismaClient): Promise<{
  permissions: number;
  rolesCreated: string[];
  orphanPermissions: string[];
  /** `ROLE → permission` granted because the code is new (D-012). */
  grantedToSystemRoles: string[];
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
    PERMISSION_CATALOGUE.map((permission) =>
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
  const known = new Set<string>(PERMISSION_CATALOGUE.map((p) => p.code));
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
  const brandNew = PERMISSION_CATALOGUE.map((p) => p.code).filter(
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

  return {
    permissions: PERMISSION_CATALOGUE.length,
    rolesCreated,
    orphanPermissions,
    grantedToSystemRoles,
  };
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
