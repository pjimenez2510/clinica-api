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
 * Two rules keep this from trampling a clinic's configuration:
 *
 *   - Permissions are upserted. The code decides which exist and what they are
 *     called, so a renamed description propagates.
 *   - Roles are created ONLY IF ABSENT, and their permissions only on
 *     creation. A clinic that removed `catalog:read` from Recepción meant it;
 *     a deploy that silently put it back would be a bug that looks like magic.
 */
export async function syncAuthorisation(prisma: PrismaClient): Promise<{
  permissions: number;
  rolesCreated: string[];
  orphanPermissions: string[];
}> {
  for (const permission of PERMISSION_CATALOGUE) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: {
        resource: permission.resource,
        description: permission.description,
      },
      create: permission,
    });
  }

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

  return {
    permissions: PERMISSION_CATALOGUE.length,
    rolesCreated,
    orphanPermissions,
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
