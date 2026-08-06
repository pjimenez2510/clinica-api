import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';

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

import {
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
} from './problem-details.types';
import { extractZodError, zodIssuesToFieldErrors } from './zod-problem';

const BASE_TYPE = 'https://api.clinica.ec/problems';

/**
 * Translates any exception into an RFC 9457 response.
 *
 * This is the ONLY place in the system that knows about HTTP status codes. The
 * domain throws `DomainError` without knowing what a 404 is, which is what lets
 * the same business rules run from a queue worker where "404" means nothing.
 *
 * Registered through APP_FILTER (not `useGlobalFilters`) so it can receive
 * dependencies by injection.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly isProduction = process.env.NODE_ENV === 'production';

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ProblemDetailsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    // No query string: it may carry a cedula or a medical record number.
    const instance = String(httpAdapter.getRequestUrl(req) ?? '').split('?')[0];
    const problem = this.toProblemDetails(exception, instance);

    /**
     * THE STATIC MESSAGE IS MANDATORY, not a style choice.
     *
     * If you hand pino an object with `err` and no message, it uses
     * `err.message` as `msg`. And `msg` is a string: serializers never touch
     * it. Nest's 404 carries the full URL — query string included — in its
     * message, so without this the cedula in the URL would leak.
     */
    const level = problem.status >= 500 ? 'error' : 'warn';
    this.logger[level](
      { err: exception, error_code: problem.code, status: problem.status },
      'request failed',
    );

    httpAdapter.setHeader?.(res, 'Content-Type', PROBLEM_CONTENT_TYPE);
    httpAdapter.reply(res, problem, problem.status);
  }

  private toProblemDetails(
    exception: unknown,
    instance: string,
  ): ProblemDetails {
    const base = { instance, timestamp: new Date().toISOString() };

    if (exception instanceof DomainError) {
      const { status, slug, title } = this.mapDomainError(exception);
      return {
        ...base,
        type: `${BASE_TYPE}/${slug}`,
        // RFC 9457: `title` summarises the problem TYPE for a human. It is not
        // the machine identifier — that is `code`. Repeating the code here
        // would make the field dead weight.
        title,
        status,
        // The technical message is only exposed outside production: it can drag
        // along details of the PostgreSQL row that caused it.
        detail: this.isProduction ? undefined : exception.message,
        code: exception.code,
        // Field errors travel in EVERY environment, unlike `detail`. They are
        // written for the user and carry no rejected values, and a validation
        // error that does not say what to fix is useless.
        ...(exception.fieldErrors?.length
          ? { errors: [...exception.fieldErrors] }
          : {}),
      };
    }

    if (exception instanceof HttpException) {
      // Request-body validation. Handled before the generic branch because Zod
      // knows exactly which field failed, and answering a bare 400 throws that
      // away — leaving the client unable to highlight the offending input.
      const zodError = extractZodError(exception);
      if (zodError) {
        return {
          ...base,
          type: `${BASE_TYPE}/validation`,
          title: 'Datos inválidos',
          // 422 and not Zod's default 400: the body parsed fine, it is the
          // CONTENT that is invalid. Same status the domain ValidationError
          // maps to, so the client has one rule instead of two.
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: 'VALIDATION_FAILED',
          errors: zodIssuesToFieldErrors(zodError),
        };
      }

      const status = exception.getStatus();
      const failed = this.failedDependencies(exception);
      const { code, title } = this.describeHttpStatus(status);
      return {
        ...base,
        type: `${BASE_TYPE}/http-${status}`,
        // NOT `exception.name`: that leaks a NestJS class name
        // ("NotFoundException") into a public contract, and renaming an
        // internal class would silently change the response.
        title,
        status,
        detail: this.isProduction ? undefined : exception.message,
        code,
        // Only the names of the failing dependencies. That is what whoever
        // debugs needs and it reveals nothing sensitive.
        ...(failed ? { failedDependencies: failed } : {}),
      };
    }

    // Unhandled exception: its message is never leaked. `err.message` from
    // Prisma or pg can contain a whole row with patient data.
    return {
      ...base,
      type: `${BASE_TYPE}/internal-error`,
      title: 'Error interno del servidor',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
    };
  }

  /**
   * Maps by error CATEGORY, not by a code-to-code registry.
   *
   * A dictionary with one entry per code would be ceremony: it must be kept by
   * hand and forgetting one entry yields a silent 500. With categories, a new
   * error inherits the right status by construction.
   */
  private mapDomainError(e: DomainError): {
    status: HttpStatus;
    slug: string;
    title: string;
  } {
    if (e instanceof ValidationError)
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        slug: 'validation',
        title: 'Datos inválidos',
      };
    if (e instanceof NotFoundError)
      return {
        status: HttpStatus.NOT_FOUND,
        slug: 'not-found',
        title: 'Recurso no encontrado',
      };
    if (e instanceof ConflictError)
      return {
        status: HttpStatus.CONFLICT,
        slug: 'conflict',
        title: 'Conflicto con el estado actual',
      };
    if (e instanceof BusinessRuleViolation)
      return {
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        slug: 'business-rule',
        title: 'Regla de negocio incumplida',
      };
    if (e instanceof UnauthorizedError)
      return {
        status: HttpStatus.UNAUTHORIZED,
        slug: 'unauthenticated',
        title: 'No autenticado',
      };
    if (e instanceof ForbiddenError)
      return {
        status: HttpStatus.FORBIDDEN,
        slug: 'forbidden',
        title: 'Acceso denegado',
      };
    if (e instanceof ExternalServiceError) {
      // A service that is down is 503 (retryable); a business rejection from
      // the SRI is 502: retrying will not fix it.
      return e.isRetryable
        ? {
            status: HttpStatus.SERVICE_UNAVAILABLE,
            slug: 'service-unavailable',
            title: 'Servicio no disponible',
          }
        : {
            status: HttpStatus.BAD_GATEWAY,
            slug: 'external-service',
            title: 'Error en un servicio externo',
          };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      slug: 'internal-error',
      title: 'Error interno del servidor',
    };
  }

  /**
   * Machine code and human title for a status, in one table.
   *
   * They are declared together on purpose: kept apart, one gets a new entry and
   * the other does not, and the response ends up describing itself two
   * different ways.
   */
  private describeHttpStatus(status: number): { code: string; title: string } {
    const known: Record<number, { code: string; title: string }> = {
      400: { code: 'BAD_REQUEST', title: 'Solicitud mal formada' },
      401: { code: 'UNAUTHENTICATED', title: 'No autenticado' },
      403: { code: 'FORBIDDEN', title: 'Acceso denegado' },
      404: { code: 'NOT_FOUND', title: 'Recurso no encontrado' },
      405: { code: 'METHOD_NOT_ALLOWED', title: 'Método no permitido' },
      409: { code: 'CONFLICT', title: 'Conflicto con el estado actual' },
      413: { code: 'PAYLOAD_TOO_LARGE', title: 'El contenido es demasiado grande' }, // prettier-ignore
      415: { code: 'UNSUPPORTED_MEDIA_TYPE', title: 'Formato no admitido' },
      422: { code: 'UNPROCESSABLE_ENTITY', title: 'Datos inválidos' },
      429: { code: 'TOO_MANY_REQUESTS', title: 'Demasiadas solicitudes' },
      500: { code: 'INTERNAL_ERROR', title: 'Error interno del servidor' },
      502: { code: 'EXTERNAL_SERVICE', title: 'Error en un servicio externo' },
      503: { code: 'SERVICE_UNAVAILABLE', title: 'Servicio no disponible' },
      504: { code: 'GATEWAY_TIMEOUT', title: 'Tiempo de espera agotado' },
    };
    return known[status] ?? { code: 'HTTP_ERROR', title: 'Error en la solicitud' }; // prettier-ignore
  }

  /**
   * Extracts the names of the failing dependencies from Terminus's response.
   *
   * Terminus throws `ServiceUnavailableException` carrying
   * `{ status, info, error, details }`. Without this the filter replaced that
   * body with a generic one and whoever debugs could not tell whether the
   * database, memory or storage had failed.
   *
   * Only indicator NAMES are taken, never their messages: the name
   * (`database`) is safe; the message can carry the connection string.
   */
  private failedDependencies(exception: HttpException): string[] | undefined {
    const body: unknown = exception.getResponse();
    if (typeof body !== 'object' || body === null) return undefined;

    const error = (body as { error?: unknown }).error;
    if (typeof error !== 'object' || error === null) return undefined;

    const names = Object.keys(error);
    return names.length > 0 ? names : undefined;
  }
}
