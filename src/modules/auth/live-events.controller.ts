import {
  type BeforeApplicationShutdown,
  Controller,
  Inject,
  type MessageEvent,
  Sse,
} from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import type { Observable } from 'rxjs';

import {
  CurrentUserService,
  MissingTokenError,
} from '../../shared/authorisation/current-user.service';
import { Principal } from '../../shared/authorisation/principal';
import { LiveEventBus } from '../../shared/events/live-event-bus';
import {
  LIVE_EVENT_PERMISSION,
  type LiveEventKind,
} from '../../shared/events/live-event';
import {
  LIVE_HEARTBEAT,
  liveEventStream,
} from '../../shared/events/live-event-stream';
import { LiveStreamRegistry } from '../../shared/events/live-stream-registry';
import {
  CURRENT_USER,
  RequirePermission,
} from '../../shared/http/auth.decorators';
import {
  NO_TIMEOUT,
  Timeout,
} from '../../shared/http/interceptors/timeout.interceptor';

import { RefreshTokenService } from './infrastructure/refresh-token.service';
import { RolePermissionRegistry } from './infrastructure/role-permission.registry';
import type { AccessTokenClaims } from './infrastructure/token.service';

/**
 * What the route demands, which is also what a session must keep holding for
 * its stream to stay open (AU-054, AU-056). The permission of the only kind of
 * event this step carries; the next step widens it (D-187, paso 2).
 */
const STREAM_PERMISSION = LIVE_EVENT_PERMISSION['critical-results' satisfies LiveEventKind]; // prettier-ignore

/**
 * Without an `exp` — never for a token `jose` signed, only for a test double —
 * the stream lives as long as the default access token.
 */
const FALLBACK_LIFETIME_MS = 15 * 60_000;

/**
 * `GET /events` — the live-events channel (D-187, AU-054 to AU-058).
 *
 * IN `auth` BECAUSE OF WHAT IT CHECKS, NOT WHAT IT CARRIES. The events are
 * other modules' (`orders` today); what this route adds to them is the
 * session: that it is still open (AU-036, AU-040) and what it may read (the
 * permissions resolved again, as the guard does on every request). Both are
 * this module's, and a controller in `shared` could not reach them.
 *
 * THE SAME GUARDS AS ANY ROUTE. The browser opens it with `fetch` and the
 * `Authorization` header, so `JwtAuthGuard` and `PermissionsGuard` decide —
 * no cookie, no ticket in the URL, no second way in.
 */
@ApiTags('auth')
@Controller({ path: 'events', version: '1' })
export class LiveEventsController implements BeforeApplicationShutdown {
  /** M2. The cap per user, and what the shutdown ends. */
  private readonly streams = new LiveStreamRegistry();

  constructor(
    private readonly bus: LiveEventBus,
    private readonly currentUser: CurrentUserService,
    private readonly sessions: RefreshTokenService,
    private readonly roles: RolePermissionRegistry,
    private readonly cls: ClsService,
    @Inject(LIVE_HEARTBEAT) private readonly heartbeatMs: number,
  ) {}

  @Sse()
  @RequirePermission(STREAM_PERMISSION, 'query')
  @Timeout(NO_TIMEOUT)
  @ApiOperation({
    summary: 'Avisos en vivo: qué cambió, nunca el dato (D-187)',
    description:
      'Flujo `text/event-stream`. Un `ready` al abrir, un `heartbeat` cada 20 s y, por cada cambio en una sede del alcance de la sesión, un evento con `{ kind, siteId }`. Se corta al caducar el token o al cerrarse la sesión; el cliente renueva y vuelve a abrir.',
  })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'El flujo de avisos.' })
  @ApiUnauthorizedResponse({ description: 'Sin sesión válida.' })
  @ApiForbiddenResponse({ description: 'Sin `record:read` en ninguna sede.' })
  stream(): Observable<MessageEvent> {
    // Read NOW, inside the request: the stream's callbacks run outside it,
    // where the request context no longer exists.
    // The claims as `JwtAuthGuard` verified them, `grants` and `exp` included.
    const claims = this.cls.get<AccessTokenClaims | undefined>(CURRENT_USER);
    if (!claims) throw new MissingTokenError();
    const principal = this.currentUser.requirePrincipal();

    return liveEventStream({
      bus: this.bus,
      principal,
      heartbeatMs: this.heartbeatMs,
      register: (end) => this.streams.track(claims.sub, end),
      lifetimeMs:
        claims.exp === undefined
          ? FALLBACK_LIFETIME_MS
          : claims.exp * 1000 - Date.now(),
      recheck: async () => {
        // AU-057. The same question `JwtAuthGuard` asks of every request.
        if ((await this.sessions.familyState(claims.fam)) !== 'open') {
          return null;
        }
        // AU-056. And the one `PermissionsGuard` asks: permissions resolved
        // again, so a withdrawn role stops hearing without waiting for the
        // token to expire.
        const current = new Principal(
          claims.sub,
          await this.roles.resolve(claims.grants),
        );
        return current.can(STREAM_PERMISSION) ? current : null;
      },
    });
  }

  /** M2. A deploy does not wait fifteen minutes for open streams. */
  beforeApplicationShutdown(): void {
    this.streams.endAll();
  }
}
