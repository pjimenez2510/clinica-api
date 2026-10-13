import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

/** Metadata key written by `@AllowHttpCache()` and read by the interceptor. */
export const ALLOW_HTTP_CACHE_KEY = 'http:allow_cache';

/**
 * AU-061. Exempts a route from the `no-store` default, and sends no
 * `Cache-Control` at all.
 *
 * Only for a response that holds nobody's data and is meant for anyone — the
 * public tariff. The exact list is asserted in `route-authorisation.spec.ts`,
 * so adding one is a decision somebody has to write down.
 */
export const AllowHttpCache = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_HTTP_CACHE_KEY, true);

/**
 * AU-061. No cache on the way keeps a response of this API, unless the route
 * says otherwise.
 *
 * Closed by default, like permissions: the consultation, the chart, the
 * patient and the access token all travel in responses, and a list of «the
 * routes that need it» goes stale the day somebody adds one (it did: the
 * assistant had it route by route and the note did not).
 *
 * Written BEFORE the handler and only when absent, because of where each
 * other source sets it:
 *   · `@Header()` is applied by Nest before the interceptors run → kept;
 *   · a handler that writes it itself (`no-store, private` on documents)
 *     overwrites it afterwards, as before;
 *   · the live-events stream sets its own in `writeHead`;
 *   · an error thrown by the handler is rendered by the filter on the same
 *     response, so it carries the header too. Rejections by the guards come
 *     before this and carry no data.
 */
@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const exempt = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_HTTP_CACHE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const response = context.switchToHttp().getResponse<Response>();
    if (exempt !== true && !response.hasHeader('Cache-Control')) {
      response.setHeader('Cache-Control', 'no-store');
    }

    return next.handle();
  }
}
