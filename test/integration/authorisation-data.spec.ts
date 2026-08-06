import { describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
import { DEFAULT_ROLES } from '../../src/modules/auth/domain/default-roles';
import { PERMISSION_CATALOGUE } from '../../src/modules/auth/domain/permissions';

import { useDatabase } from './setup/database';

/**
 * Roles are data; the permission catalogue is code. These prove the seam
 * between the two holds, and that the database defends the things a wrong
 * click could otherwise destroy.
 */
describe('roles are data, permissions are a contract', () => {
  const db = useDatabase();

  it('mirrors the code catalogue into the database', async () => {
    // The table exists so role assignments have referential integrity and the
    // admin screen can list what is assignable. If the two drift, the screen
    // offers permissions that protect nothing.
    const prisma = db();
    await syncAuthorisation(prisma);

    const stored = await prisma.permission.findMany({
      select: { code: true, resource: true, description: true },
      orderBy: { code: 'asc' },
    });

    expect(stored).toEqual(
      [...PERMISSION_CATALOGUE]
        .map((p) => ({ ...p }))
        .sort((a, b) => a.code.localeCompare(b.code)),
    );
  });

  it('creates the default roles once and never overwrites them', async () => {
    // A clinic that removed a permission meant it. A deploy putting it back
    // would be a bug that looks like magic.
    const prisma = db();
    await syncAuthorisation(prisma);

    const recepcion = await prisma.role.findUniqueOrThrow({
      where: { code: 'RECEPCION' },
    });
    await prisma.rolePermission.delete({
      where: {
        roleId_permissionCode: {
          roleId: recepcion.id,
          permissionCode: 'catalog:read',
        },
      },
    });

    const second = await syncAuthorisation(prisma);

    expect(second.rolesCreated).toEqual([]);
    const after = await prisma.rolePermission.findMany({
      where: { roleId: recepcion.id },
      select: { permissionCode: true },
    });
    expect(after.map((p) => p.permissionCode)).not.toContain('catalog:read');
  });

  it('lets a clinic invent a role the code never heard of', async () => {
    // The entire point of the refactor. An enum would have needed a migration
    // and a deploy for this.
    const prisma = db();
    await syncAuthorisation(prisma);

    const liaison = await prisma.role.create({
      data: {
        code: 'ENLACE_SEGUROS',
        name: 'Enlace con aseguradoras',
        description: 'Prepara prefacturas y responde glosas.',
        permissions: {
          create: [
            { permissionCode: 'patient:read' },
            { permissionCode: 'billing:read' },
          ],
        },
      },
      include: { permissions: true },
    });

    expect(liaison.permissions).toHaveLength(2);
    expect(liaison.isSystem).toBe(false);
  });

  it('REFUSES a role code that is not an identifier', async () => {
    // The code appears in seeds, logs and support conversations. A lowercase
    // or spaced one makes those unsearchable.
    const prisma = db();

    await expect(
      prisma.role.create({
        data: { code: 'enlace seguros', name: 'Enlace' },
      }),
    ).rejects.toThrow(/role_code_shape/);
  });

  it('REFUSES deleting a role that ships with the product', async () => {
    const prisma = db();
    await syncAuthorisation(prisma);
    const admin = await prisma.role.findUniqueOrThrow({
      where: { code: 'ADMIN' },
    });

    await expect(
      prisma.role.delete({ where: { id: admin.id } }),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('REFUSES renaming the code of a system role', async () => {
    const prisma = db();
    await syncAuthorisation(prisma);
    const medico = await prisma.role.findUniqueOrThrow({
      where: { code: 'MEDICO' },
    });

    await expect(
      prisma.role.update({
        where: { id: medico.id },
        data: { code: 'DOCTOR' },
      }),
    ).rejects.toThrow(/code of system role/);

    // The display name is not an identifier and can change freely.
    const renamed = await prisma.role.update({
      where: { id: medico.id },
      data: { name: 'Médico tratante' },
    });
    expect(renamed.name).toBe('Médico tratante');
  });

  it('lets an administrator edit what a system role may do', async () => {
    // Deliberately allowed. The permissions of a shipped role are the clinic's
    // policy, not the code's — that is the whole reason for this refactor.
    const prisma = db();
    await syncAuthorisation(prisma);
    const enfermeria = await prisma.role.findUniqueOrThrow({
      where: { code: 'ENFERMERIA' },
    });

    await prisma.rolePermission.create({
      data: { roleId: enfermeria.id, permissionCode: 'agenda:write' },
    });

    const permissions = await prisma.rolePermission.findMany({
      where: { roleId: enfermeria.id },
    });
    expect(permissions.map((p) => p.permissionCode)).toContain('agenda:write');
  });

  it('REFUSES leaving nobody able to manage users', async () => {
    // The Friday-afternoon failure: an administrator tidies up permissions and
    // locks the whole clinic out of its own configuration, including whoever
    // would undo it.
    const prisma = db();
    await syncAuthorisation(prisma);
    const admin = await prisma.role.findUniqueOrThrow({
      where: { code: 'ADMIN' },
    });

    await expect(
      prisma.rolePermission.delete({
        where: {
          roleId_permissionCode: {
            roleId: admin.id,
            permissionCode: 'user:manage',
          },
        },
      }),
    ).rejects.toThrow(/must keep user:manage/);
  });

  it('allows moving user:manage to another role in one transaction', async () => {
    // The constraint trigger is DEFERRED precisely so this works: handing the
    // permission over must not be blocked just because the two statements
    // cannot be simultaneous.
    const prisma = db();
    await syncAuthorisation(prisma);
    const admin = await prisma.role.findUniqueOrThrow({
      where: { code: 'ADMIN' },
    });

    const director = await prisma.role.create({
      data: { code: 'DIRECTOR', name: 'Director médico' },
    });

    await prisma.$transaction(async (tx) => {
      await tx.rolePermission.delete({
        where: {
          roleId_permissionCode: {
            roleId: admin.id,
            permissionCode: 'user:manage',
          },
        },
      });
      await tx.rolePermission.create({
        data: { roleId: director.id, permissionCode: 'user:manage' },
      });
    });

    const holders = await prisma.rolePermission.findMany({
      where: { permissionCode: 'user:manage' },
      select: { roleId: true },
    });
    expect(holders.map((h) => h.roleId)).toEqual([director.id]);
  });

  it('REFUSES assigning a permission the code does not define', async () => {
    // Referential integrity is what stops the admin screen from offering a
    // permission that protects nothing.
    const prisma = db();
    await syncAuthorisation(prisma);
    const role = await prisma.role.create({
      data: { code: 'PRUEBA', name: 'Prueba' },
    });

    await expect(
      prisma.rolePermission.create({
        data: { roleId: role.id, permissionCode: 'inventado:absoluto' },
      }),
    ).rejects.toThrow(/Foreign key constraint/);
  });

  it('keeps the shipped separation between administering and treating', () => {
    // No longer enforced by the code — it is a default now, and the clinic can
    // change it. It must still be what a fresh installation starts with.
    const admin = DEFAULT_ROLES.find((role) => role.code === 'ADMIN');
    const clinical = admin?.permissions.filter((p) => p.startsWith('record:'));

    expect(clinical).toEqual([]);
    expect(
      DEFAULT_ROLES.find((role) => role.code === 'RECEPCION')?.permissions,
    ).not.toContain('record:read');
  });
});
