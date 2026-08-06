import {
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  RequestTimeoutException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, TimeoutError, throwError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';

/** Milliseconds before cutting a request off. Overridable per route. */
export const DEFAULT_TIMEOUT_MS = 15_000;

const TIMEOUT_KEY = 'timeout_ms';

/**
 * Overrides the timeout of a specific route.
 *
 * The SRI web services take seconds and sometimes over a minute, so the routes
 * that talk to them need a much wider margin than a normal query.
 */
export const Timeout = (ms: number): MethodDecorator =>
  // `SetMetadata`, like every other decorator in the project. Reaching for
  // `Reflect.defineMetadata` directly worked, but being the single exception
  // to a pattern with no reason written down is how a codebase stops having
  // patterns.
  SetMetadata(TIMEOUT_KEY, ms);

/**
 * Cuts off requests that run longer than acceptable.
 *
 * Without this, a stuck query keeps the connection, the socket and its slot in
 * the pool. A handful of them is enough to exhaust the pool and leave the API
 * unable to answer anything — including the health probe.
 *
 * IMPORTANT LIMITATION: this aborts the RESPONSE, not the work. The query keeps
 * running in PostgreSQL until it finishes. Cutting it off for real needs
 * `statement_timeout` on the database. This interceptor protects the client and
 * the sockets; `statement_timeout` protects the database.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ms =
      this.reflector.get<number | undefined>(
        TIMEOUT_KEY,
        context.getHandler(),
      ) ?? DEFAULT_TIMEOUT_MS;

    return next.handle().pipe(
      timeout(ms),
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof TimeoutError
            ? // Converted to a Nest exception so the filter renders it as
              // RFC 9457 like any other error, instead of escaping as an
              // unformatted RxJS error.
              new RequestTimeoutException(`Operation exceeded ${ms} ms`)
            : error,
        ),
      ),
    );
  }
}
