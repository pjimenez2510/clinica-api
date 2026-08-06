import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { ResolvedGrant } from '../../../shared/authorisation/principal';

/**
 * Resolves a role into its permissions, with a short-lived cache.
 *
 * WHY A CACHE AND NOT THE TOKEN: once role permissions are editable, putting
 * them in the access token means a revoked permission keeps working until the
 * token expires — up to fifteen minutes of clinical access somebody just took
 * away. That is the wrong thing to be relaxed about, so the token carries only
 * WHICH ROLES the caller holds and the permissions are resolved per request.
 *
 * WHY NOT A QUERY PER REQUEST: the target is under a second for a doctor's
 * frequent operations, and this would add a join to every single one. The map
 * is small — a handful of roles — and changes only when an administrator edits
 * a role.
 *
 * THE TTL IS THE COMPROMISE, and 30 seconds is chosen so that an urgent
 * revocation takes effect while somebody is still watching the screen.
 * `invalidate()` makes it immediate; the TTL is what covers a second instance
 * that did not receive the call. When there is more than one instance this
 * should become a Redis pub/sub invalidation — noted, not built, because
 * building it now would be guessing at a deployment that does not exist yet.
 */
const CACHE_TTL_MS = 30_000;

interface CachedRole {
  code: string;
  permissions: string[];
}

@Injectable()
export class RolePermissionRegistry {
  private cache: Map<string, CachedRole> | null = null;
  private loadedAt = 0;
  /** Concurrent requests during a reload share one query instead of racing. */
  private inFlight: Promise<Map<string, CachedRole>> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RolePermissionRegistry.name);
  }

  /** Drops the cache so the next request reads the database. */
  invalidate(): void {
    this.cache = null;
    this.loadedAt = 0;
  }

  /**
   * Turns the role ids carried by a token into permissions.
   *
   * A role that no longer exists, or has been deactivated, resolves to NOTHING
   * rather than being skipped silently — the caller simply holds no permission
   * through it. Deactivating a role therefore takes effect within the TTL,
   * which is the point.
   */
  async resolve(
    grants: readonly { roleId: string; siteId: string | null }[],
  ): Promise<ResolvedGrant[]> {
    if (grants.length === 0) return [];

    const roles = await this.load();

    return grants.flatMap((grant) => {
      const role = roles.get(grant.roleId);
      if (!role) return [];
      return [
        {
          roleCode: role.code,
          siteId: grant.siteId,
          permissions: role.permissions,
        },
      ];
    });
  }

  private async load(): Promise<Map<string, CachedRole>> {
    const fresh = this.cache && Date.now() - this.loadedAt < CACHE_TTL_MS;
    if (fresh && this.cache) return this.cache;

    this.inFlight ??= this.read().finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  private async read(): Promise<Map<string, CachedRole>> {
    // Inactive roles are excluded by the QUERY. Filtering afterwards is a step
    // somebody can forget, and the consequence is a deactivated role still
    // granting clinical access.
    const roles = await this.prisma.role.findMany({
      where: { active: true },
      select: {
        id: true,
        code: true,
        permissions: { select: { permissionCode: true } },
      },
    });

    const map = new Map<string, CachedRole>(
      roles.map((role) => [
        role.id,
        {
          code: role.code,
          permissions: role.permissions.map((p) => p.permissionCode),
        },
      ]),
    );

    this.cache = map;
    this.loadedAt = Date.now();
    this.logger.debug({ role_count: map.size }, 'role permissions loaded');
    return map;
  }
}
