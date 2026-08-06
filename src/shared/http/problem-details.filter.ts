import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

import {
  BusinessRuleViolation,
  ConflictError,
  DomainError,
  ExternalServiceError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../domain/errors/domain-error';

import { PROBLEM_CONTENT_TYPE, type ProblemDetails } from './problem-details.types';

const BASE_TYPE = 'https://api.clinica.ec/problems';

/**
 * Traduce cualquier excepción a una respuesta RFC 9457.
 *
 * Es el ÚNICO sitio del sistema que conoce códigos HTTP. El dominio lanza
 * `DomainError` sin saber qué es un 404; gracias a eso las mismas reglas de
 * negocio se reutilizan desde un worker de cola, donde "404" no significa nada.
 *
 * Se registra con APP_FILTER (no con `useGlobalFilters`) para que pueda recibir
 * dependencias por inyección.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);
  private readonly esProduccion = process.env.NODE_ENV === 'production';

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();
    const req = ctx.getRequest();
    const res = ctx.getResponse();

    // Sin query string: puede llevar cédula o número de historia clínica.
    const instance = String(httpAdapter.getRequestUrl(req) ?? '').split('?')[0];
    const problema = this.aProblemDetails(exception, instance);

    // El error COMPLETO va al log, donde el pipeline de redacción lo limpia.
    // La respuesta HTTP solo lleva lo que está en `problema`.
    const nivel = problema.status >= 500 ? 'error' : 'warn';
    this.logger[nivel]({
      err: exception,
      error_code: problema.code,
      status: problema.status,
    });

    httpAdapter.setHeader?.(res, 'Content-Type', PROBLEM_CONTENT_TYPE);
    httpAdapter.reply(res, problema, problema.status);
  }

  private aProblemDetails(exception: unknown, instance: string): ProblemDetails {
    const base = { instance, timestamp: new Date().toISOString() };

    if (exception instanceof DomainError) {
      const { status, slug } = this.mapear(exception);
      return {
        ...base,
        type: `${BASE_TYPE}/${slug}`,
        title: exception.code,
        status,
        // El mensaje técnico solo se expone fuera de producción: puede arrastrar
        // detalles de la fila de PostgreSQL que lo originó.
        detail: this.esProduccion ? undefined : exception.message,
        code: exception.code,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        ...base,
        type: `${BASE_TYPE}/http-${status}`,
        title: exception.name,
        status,
        detail: this.esProduccion ? undefined : exception.message,
        code: this.codigoHttp(status),
      };
    }

    // Excepción no controlada: nunca se filtra su mensaje. `err.message` de
    // Prisma o de pg puede contener una fila entera con datos del paciente.
    return {
      ...base,
      type: `${BASE_TYPE}/error-interno`,
      title: 'Error interno del servidor',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'ERROR_INTERNO',
    };
  }

  /**
   * Mapea por CATEGORÍA de error, no por un registro código a código.
   *
   * Un diccionario con una entrada por cada código sería ceremonia: habría que
   * mantenerlo a mano y olvidarse de una entrada daría un 500 silencioso. Con
   * categorías, un error nuevo hereda el estado correcto por construcción.
   */
  private mapear(e: DomainError): { status: HttpStatus; slug: string } {
    if (e instanceof ValidationError)
      return { status: HttpStatus.UNPROCESSABLE_ENTITY, slug: 'validacion' };
    if (e instanceof NotFoundError)
      return { status: HttpStatus.NOT_FOUND, slug: 'no-encontrado' };
    if (e instanceof ConflictError) return { status: HttpStatus.CONFLICT, slug: 'conflicto' };
    if (e instanceof BusinessRuleViolation)
      return { status: HttpStatus.UNPROCESSABLE_ENTITY, slug: 'regla-de-negocio' };
    if (e instanceof UnauthorizedError)
      return { status: HttpStatus.UNAUTHORIZED, slug: 'no-autenticado' };
    if (e instanceof ForbiddenError) return { status: HttpStatus.FORBIDDEN, slug: 'sin-permiso' };
    if (e instanceof ExternalServiceError) {
      // Un servicio caído es 503 (reintentable); un rechazo de negocio del SRI
      // es 502: reintentar no lo va a arreglar.
      return e.esReintentable
        ? { status: HttpStatus.SERVICE_UNAVAILABLE, slug: 'servicio-no-disponible' }
        : { status: HttpStatus.BAD_GATEWAY, slug: 'servicio-externo' };
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, slug: 'error-interno' };
  }

  private codigoHttp(status: number): string {
    const conocidos: Record<number, string> = {
      400: 'PETICION_INVALIDA',
      401: 'NO_AUTENTICADO',
      403: 'SIN_PERMISO',
      404: 'NO_ENCONTRADO',
      409: 'CONFLICTO',
      422: 'ENTIDAD_NO_PROCESABLE',
      429: 'DEMASIADAS_PETICIONES',
    };
    return conocidos[status] ?? 'ERROR_HTTP';
  }
}
