import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

import { RolePermissionRegistry } from './role-permission.registry';

/**
 * AU-012 — «resolver los permisos POR PETICIÓN y no dentro del token, para que
 * revocar surta efecto en segundos».
 *
 * NADIE PROBABA ESTA CLASE. `accounts.service.spec` comprueba que cambiar los
 * roles de una cuenta llame a `invalidate()` (AU-032), que es la mitad de
 * arriba; lo que hace el registro cuando lo llaman —y, sobre todo, lo que hace
 * cuando NO lo llaman— no lo miraba nada. Y ahí es donde vive el requisito: el
 * TTL es la garantía de que una revocación surte efecto aunque la llamada de
 * invalidación se pierda, que es justo lo que pasa con una segunda instancia.
 *
 * EL RELOJ SE FIJA. Comprobar un TTL de 30 segundos esperando 30 segundos
 * convierte la suite en algo que nadie ejecuta.
 */
describe('AU-012 la resolución de permisos por petición', () => {
  const INICIO = new Date('2026-08-13T14:00:00Z');

  let findMany: ReturnType<typeof vi.fn>;
  let registry: RolePermissionRegistry;

  /** Una fila de rol como la devuelve la consulta. */
  function role(code: string, ...permissions: string[]) {
    return {
      id: `role-${code}`,
      code,
      permissions: permissions.map((permissionCode) => ({ permissionCode })),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(INICIO);

    findMany = vi.fn().mockResolvedValue([role('MEDICO', 'agenda:read')]);

    const logger = {
      setContext: vi.fn(),
      debug: vi.fn(),
    } as unknown as PinoLogger;

    registry = new RolePermissionRegistry(
      { role: { findMany } } as unknown as PrismaService,
      logger,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const grants = [{ roleId: 'role-MEDICO', siteId: null }];

  it('AU-012 el token no lleva los permisos: se resuelven contra la base', async () => {
    const resolved = await registry.resolve(grants);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(resolved).toEqual([
      { roleCode: 'MEDICO', siteId: null, permissions: ['agenda:read'] },
    ]);
  });

  it('AU-012 una revocación surte efecto en la petición siguiente al invalidar', async () => {
    await registry.resolve(grants);

    findMany.mockResolvedValue([role('MEDICO')]);
    registry.invalidate();

    // Sin esperar nada: es el camino que recorre un administrador que acaba de
    // quitar un permiso y quiere que deje de valer AHORA.
    expect(await registry.resolve(grants)).toEqual([
      { roleCode: 'MEDICO', siteId: null, permissions: [] },
    ]);
  });

  it('AU-012 sin invalidar, la revocación entra igual pasados 30 segundos', async () => {
    /**
     * ESTA ES LA GARANTÍA QUE SOSTIENE «EN SEGUNDOS». `invalidate()` sólo
     * alcanza a la instancia que recibió la llamada; el TTL es lo que cubre a
     * las demás el día que haya más de una. Sin él, una revocación urgente
     * podría no llegar nunca a un proceso que nadie avisó.
     */
    await registry.resolve(grants);
    findMany.mockResolvedValue([role('MEDICO')]);

    // A los 29 segundos todavía sirve la copia: es una caché, y se dice.
    vi.setSystemTime(new Date(INICIO.getTime() + 29_000));
    expect((await registry.resolve(grants))[0]?.permissions).toEqual([
      'agenda:read',
    ]);

    vi.setSystemTime(new Date(INICIO.getTime() + 31_000));
    expect((await registry.resolve(grants))[0]?.permissions).toEqual([]);
  });

  it('AU-012 un rol desactivado deja de conceder, no concede en silencio', async () => {
    // La consulta excluye los inactivos, así que el rol desaparece del mapa y
    // la concesión que lo nombra no aporta nada — en vez de saltarse el filtro
    // y seguir dando acceso clínico.
    await registry.resolve(grants);

    findMany.mockResolvedValue([]);
    registry.invalidate();

    expect(await registry.resolve(grants)).toEqual([]);
  });

  it('AU-012 pide sólo los roles activos a la base, no filtra después', async () => {
    await registry.resolve(grants);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true } }),
    );
  });

  it('AU-012 un permiso que el catálogo ya no define no concede nada', async () => {
    // Cierra en falso: una fila que quedó de un despliegue a medias parecería
    // un permiso que el llamante tiene, y no lo pide ninguna ruta.
    findMany.mockResolvedValue([
      role('MEDICO', 'agenda:read', 'permiso:inventado'),
    ]);
    registry.invalidate();

    expect((await registry.resolve(grants))[0]?.permissions).toEqual([
      'agenda:read',
    ]);
  });

  it('AU-012 varias peticiones a la vez comparten una sola consulta', async () => {
    // Al caducar la caché, cada petición en vuelo dispararía la suya. Con
    // tráfico real eso es una ráfaga contra la base cada treinta segundos.
    await Promise.all([
      registry.resolve(grants),
      registry.resolve(grants),
      registry.resolve(grants),
    ]);

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('AU-012 sin concesiones no pregunta nada a la base', async () => {
    expect(await registry.resolve([])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
