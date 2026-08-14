import { describe, expect, it } from 'vitest';

import { syncAuthorisation } from '../../prisma/seed-authorisation.mts';
// LA SEMILLA DE DESARROLLO, ejercida de verdad. Era el camino que concedía
// `user:reset-mfa` sin que nadie lo pidiera y el único que ninguna prueba
// recorría; importarla exige que `seed.mts` no siembre al cargarse, que es por
// lo que su `main()` está detrás de una comprobación de `process.argv`.
import { seedDevelopment } from '../../prisma/seed.mts';
import { DEFAULT_ROLES } from '../../src/modules/auth/domain/default-roles';
import {
  EXPLICIT_GRANT_ONLY_PERMISSIONS,
  PERMISSION_DEFINITIONS,
  SEEDABLE_PERMISSIONS,
} from '../../src/shared/authorisation/permission.catalogue';

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
      [...PERMISSION_DEFINITIONS]
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

  it('D-012: grants a BRAND-NEW permission to the system roles that declare it', async () => {
    // Without this a new feature ships unreachable: the permission exists, no
    // role holds it, and the screen that would grant it is itself behind a
    // permission. It happened with `config:*`.
    const prisma = db();
    await syncAuthorisation(prisma);

    const admin = await prisma.role.findUniqueOrThrow({
      where: { code: 'ADMIN' },
    });
    // Simulates the deploy before the code existed: remove the grant AND the
    // permission itself, which is what makes it new rather than revoked.
    await prisma.rolePermission.deleteMany({
      where: { roleId: admin.id, permissionCode: 'config:read' },
    });
    await prisma.permission.delete({ where: { code: 'config:read' } });

    const result = await syncAuthorisation(prisma);

    expect(result.grantedToSystemRoles).toContain('ADMIN → config:read');
    const after = await prisma.rolePermission.findMany({
      where: { roleId: admin.id },
      select: { permissionCode: true },
    });
    expect(after.map((p) => p.permissionCode)).toContain('config:read');
  });

  it('D-012: a permission the clinic REVOKED is never handed back', async () => {
    // The narrowness is the whole safety argument: only a code that did not
    // exist is granted, and a code that never existed cannot have been
    // revoked by anybody. Same shape as the RECEPCION case above, on a
    // permission that D-012 does grant when it is new.
    const prisma = db();
    await syncAuthorisation(prisma);

    const admin = await prisma.role.findUniqueOrThrow({
      where: { code: 'ADMIN' },
    });
    // The permission STAYS in the catalogue: this is a revocation, not a
    // missing code.
    await prisma.rolePermission.deleteMany({
      where: { roleId: admin.id, permissionCode: 'config:manage' },
    });

    const result = await syncAuthorisation(prisma);

    expect(result.grantedToSystemRoles).toEqual([]);
    const after = await prisma.rolePermission.findMany({
      where: { roleId: admin.id },
      select: { permissionCode: true },
    });
    expect(after.map((p) => p.permissionCode)).not.toContain('config:manage');
  });

  it('AU-035 does not hand `user:reset-mfa` to any role that ships with the product', async () => {
    /**
     * D-014, AND THE ONE CASE WHERE D-012's THIRD RULE MUST NOT FIRE.
     *
     * A brand-new permission code is granted to the system roles WHOSE
     * DEFINITION DECLARES IT, which is what stops a feature shipping
     * unreachable. `user:reset-mfa` is deliberately declared by none of them:
     * whoever resets a doctor's second factor removes the last barrier between
     * a password and their signature, and if they can also re-invite that
     * doctor (AU-021) they can sign in their name. The non-repudiation of the
     * trail — the SPDP's primary evidence (REQ-110) — rests on that not
     * arriving by inheritance, so the installation has to grant it to somebody
     * on purpose.
     *
     * This is asserted after a FRESH sync, which is the deploy that introduces
     * the code: the moment D-012 would have granted it.
     */
    const prisma = db();
    const result = await syncAuthorisation(prisma);

    expect(
      result.grantedToSystemRoles.filter((granted) =>
        granted.includes('user:reset-mfa'),
      ),
    ).toEqual([]);

    const holders = await prisma.rolePermission.findMany({
      where: { permissionCode: 'user:reset-mfa' },
      select: { role: { select: { code: true } } },
    });
    expect(
      holders.map((holder) => holder.role.code),
      'ningún rol de fábrica puede traer user:reset-mfa concedido',
    ).toEqual([]);
  });

  it('AU-035 keeps `user:reset-mfa` out of every shipped role definition', () => {
    // La mitad que no necesita base de datos, y la que falla primero si
    // alguien lo añade a DEFAULT_ROLES «para que el administrador pueda».
    const declaring = DEFAULT_ROLES.filter((role) =>
      role.permissions.includes('user:reset-mfa'),
    ).map((role) => role.code);

    expect(declaring).toEqual([]);
  });

  it('AU-035 la semilla de desarrollo tampoco concede un permiso de riesgo', async () => {
    /**
     * ═══════════════════════════════════════════════════════════════════════
     * EL CAMINO QUE SÍ LO CONCEDÍA, Y AL QUE NINGUNA PRUEBA LLEGABA.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * Las dos pruebas de arriba recorren `syncAuthorisation`, que nunca fue el
     * problema. `prisma/seed.mts` reconstruye el rol `DESARROLLO` a partir del
     * catálogo en cada ejecución, así que `user:reset-mfa` aterrizaba ahí solo
     * el día en que se declaró, y la única barrera era
     * `NODE_ENV !== 'production'`: cualquier staging, UAT o demo sembrada con
     * `pnpm db:seed` concedía el permiso que permite apropiarse de la cuenta
     * de cualquier médico.
     *
     * Para un permiso al que AU-035 dedica un párrafo explicando por qué no
     * puede llegar por herencia, «esto no es producción» es más flojo que el
     * resto del argumento.
     */
    const prisma = db();
    await seedDevelopment(prisma);

    // La semilla corrió de verdad: sin esto, un fallo silencioso dejaría la
    // aserción de abajo pasando sobre una base vacía.
    const superuser = await prisma.role.findUniqueOrThrow({
      where: { code: 'DESARROLLO' },
      select: { id: true, permissions: { select: { permissionCode: true } } },
    });
    const granted = superuser.permissions.map((p) => p.permissionCode);
    expect(granted.length).toBe(SEEDABLE_PERMISSIONS.length);
    expect(granted).toContain('user:manage');

    for (const risky of EXPLICIT_GRANT_ONLY_PERMISSIONS) {
      expect(granted, `${risky} no puede llegar por una semilla`).not.toContain(
        risky,
      );
    }

    // Y no por otra puerta: NINGÚN rol lo tiene tras sembrar.
    const holders = await prisma.rolePermission.findMany({
      where: { permissionCode: { in: [...EXPLICIT_GRANT_ONLY_PERMISSIONS] } },
      select: { role: { select: { code: true } } },
    });
    expect(holders.map((holder) => holder.role.code)).toEqual([]);
  });

  it('AU-035 la semilla de desarrollo deja la cuenta sin segundo factor a medias ni códigos viejos', async () => {
    // La promesa del seed es «el mismo estado conocido». Dejó de ser cierta
    // con A4: limpiaba el secreto y la marca de matrícula, pero no el secreto
    // PENDIENTE de un cambio a medias (AU-037) ni los códigos de respaldo, así
    // que diez credenciales de una prueba manual anterior seguían abriendo una
    // cuenta que la pantalla presentaba como sin segundo factor.
    const prisma = db();
    await seedDevelopment(prisma);

    const account = await prisma.user.findUniqueOrThrow({
      where: { email: 'medico@clinica.ec' },
    });
    await prisma.user.update({
      where: { id: account.id },
      data: {
        mfaEnabledAt: new Date(),
        mfaSecretEncrypted: 'viejo',
        mfaPendingSecretEncrypted: 'a-medias',
        mfaLastStep: 42n,
      },
    });
    await prisma.backupCode.create({
      data: { userId: account.id, codeHash: 'da-igual' },
    });

    await seedDevelopment(prisma);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(after.mfaEnabledAt).toBeNull();
    expect(after.mfaSecretEncrypted).toBeNull();
    expect(after.mfaPendingSecretEncrypted).toBeNull();
    expect(after.mfaLastStep).toBeNull();
    expect(
      await prisma.backupCode.count({ where: { userId: account.id } }),
    ).toBe(0);
  });

  it('AU-035 still offers `user:reset-mfa` in the catalogue, so a clinic can grant it', () => {
    // No concedido no es no existente: si el código no lo declarase, la
    // pantalla de administración no podría concedérselo a nadie y el permiso
    // sería inalcanzable — que es el fallo opuesto y también deja al médico
    // fuera.
    expect(PERMISSION_DEFINITIONS.map((p) => p.code)).toContain(
      'user:reset-mfa',
    );
  });

  // SIN ACENTOS GRAVES EN EL TÍTULO, y no es estilo: `scripts/estado.mts` lee
  // los identificadores con una expresión que corta el título en el primer
  // acento grave y descarta la prueba entera. Un título con uno se vuelve
  // INVISIBLE para la trazabilidad — la prueba pasa y el requisito figura sin
  // cubrir, que es el fallo más caro de detectar de los dos.
  it('AG-099 el administrador trae los permisos de configuración de la semilla, y se pueden reasignar', async () => {
    /**
     * LAS DOS MITADES DEL REQUISITO, Y LA SEGUNDA ES LA QUE IMPORTA.
     *
     * Que el administrador los traiga de fábrica es lo que hace que una
     * instalación recién montada pueda cargar los feriados y las antelaciones
     * que E7 lee; sin eso la pantalla de configuración está detrás de un
     * permiso que nadie tiene y la agenda opera para siempre con los defectos
     * del código (AG-095).
     *
     * Que se puedan REASIGNAR sin desplegar es la otra mitad, y es la que
     * distingue este requisito de una constante: los permisos son filas de
     * `role_permission`, así que una clínica puede dárselos a su jefa de
     * enfermería. Se comprueba concediéndolos a un rol que la instalación
     * inventó, que es exactamente el caso de D-002.
     */
    const prisma = db();
    await syncAuthorisation(prisma);

    const admin = await prisma.role.findUniqueOrThrow({
      where: { code: 'ADMIN' },
      select: { permissions: { select: { permissionCode: true } } },
    });
    const granted = admin.permissions.map((p) => p.permissionCode);
    expect(granted).toContain('settings:read');
    expect(granted).toContain('settings:manage');

    const coordination = await prisma.role.create({
      data: {
        code: 'COORDINACION',
        name: 'Coordinación asistencial',
        permissions: {
          create: [
            { permissionCode: 'settings:read' },
            { permissionCode: 'settings:manage' },
          ],
        },
      },
      include: { permissions: true },
    });

    expect(
      coordination.permissions.map((p) => p.permissionCode).sort(),
    ).toEqual(['settings:manage', 'settings:read']);
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
