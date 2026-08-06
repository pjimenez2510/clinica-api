import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  RequestTimeoutException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type Observable, TimeoutError, throwError } from 'rxjs';
import { catchError, timeout } from 'rxjs/operators';

/** Milisegundos antes de cortar. Se ajusta por ruta con `@Timeout()`. */
export const TIMEOUT_POR_DEFECTO_MS = 15_000;

const CLAVE_TIMEOUT = 'timeout_ms';

/**
 * Sobrescribe el timeout de una ruta concreta.
 *
 * Los WS del SRI tardan segundos y a veces más de un minuto, así que las rutas
 * que hablan con ellos necesitan un margen mucho mayor que una consulta normal.
 */
export const Timeout =
  (ms: number): MethodDecorator =>
  (_target, _key, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(CLAVE_TIMEOUT, ms, descriptor.value as object);
    return descriptor;
  };

/**
 * Corta las peticiones que se alargan más de lo aceptable.
 *
 * Sin esto, una consulta bloqueada mantiene abierta la conexión, el socket y su
 * hueco en el pool. Basta un puñado para agotar el pool y dejar la API sin
 * capacidad de responder a nada — incluido el sondeo de salud.
 *
 * ⚠️ LÍMITE IMPORTANTE: esto aborta la RESPUESTA, no el trabajo. La consulta
 * sigue corriendo en PostgreSQL hasta que termine. Para cortar de verdad hace
 * falta `statement_timeout` en la base. Este interceptor protege al cliente y a
 * los sockets; el `statement_timeout` protege a la base.
 */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ms =
      this.reflector.get<number | undefined>(
        CLAVE_TIMEOUT,
        context.getHandler(),
      ) ?? TIMEOUT_POR_DEFECTO_MS;

    return next.handle().pipe(
      timeout(ms),
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof TimeoutError
            ? // Se convierte a excepción de NestJS para que el filtro la traduzca
              // a RFC 9457 igual que cualquier otro error, en vez de escaparse
              // como un error de RxJS sin formato.
              new RequestTimeoutException(`La operación superó ${ms} ms`)
            : error,
        ),
      ),
    );
  }
}
