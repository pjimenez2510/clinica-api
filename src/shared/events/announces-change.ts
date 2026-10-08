import {
  applyDecorators,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
  UseInterceptors,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, tap } from 'rxjs';

import { type LiveEventKind, liveEventSchema } from './live-event';
import { LiveEventBus } from './live-event-bus';

export const ANNOUNCES_CHANGE_KEY = 'live:announces-change';

/**
 * AG-179, BI-238. «A write through this route changes what these screens of
 * the site show»: after the handler answers successfully, publish each kind
 * for the site in the route (D-187, paso 2).
 *
 * FOR THE CONTROLLERS WHOSE SITE IS IN THE URL (`agenda/sites/:siteId`,
 * `billing/sites/:siteId`), and only those: the site is then the one the
 * guard has already authorised (`param:siteId`), not something read from a
 * body. Where the site is not in the URL —the attention, the vouchers— the
 * service publishes with the site it already holds, as `orders` does.
 *
 * ON THE CLASS IT COVERS EVERY WRITE; on a handler it REPLACES the class's
 * list (`getAllAndOverride`), and an empty list silences that handler.
 */
export const AnnouncesChange = (
  ...kinds: LiveEventKind[]
): ClassDecorator & MethodDecorator =>
  applyDecorators(
    SetMetadata(ANNOUNCES_CHANGE_KEY, kinds),
    UseInterceptors(AnnounceChangeInterceptor),
  );

/** The route parameter that names the site; the same one `param:siteId` checks. */
const SITE_PARAM = 'siteId';

/**
 * Marks the request once it is being announced. On a class AND on one of its
 * handlers the decorator registers the interceptor twice, and Nest runs both:
 * the second one passes through, so a write is said once.
 */
const ANNOUNCING = Symbol('live:announcing');

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class AnnounceChangeInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly bus: LiveEventBus,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const kinds = this.reflector.getAllAndOverride<LiveEventKind[] | undefined>(
      ANNOUNCES_CHANGE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest<{
      method?: string;
      params?: Record<string, string | undefined>;
      [ANNOUNCING]?: true;
    }>();
    if (request[ANNOUNCING]) return next.handle();
    request[ANNOUNCING] = true;
    // Only a write announces. A read changes nothing, and Express answers a
    // `HEAD` with the `GET` handler: a loop of them would wake every screen
    // of the site, each one leaving its row in the access log (revisión
    // clínica M2).
    if (!kinds?.length || !WRITES.has(request.method ?? '')) {
      return next.handle();
    }
    const siteId = request.params?.[SITE_PARAM];

    // `tap` on the value: the handler RESOLVED, so its transaction committed.
    // An error never reaches here, and nothing is said about a write that
    // did not happen.
    return next.handle().pipe(
      tap(() => {
        for (const kind of kinds) {
          // The same validation as on the way in from Redis: a site that is
          // not a uuid is not an event (AU-055).
          const event = liveEventSchema.safeParse({ kind, siteId });
          if (event.success) this.bus.publish(event.data);
        }
      }),
    );
  }
}
