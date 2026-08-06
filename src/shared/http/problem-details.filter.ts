import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import type { Request, Response } from 'express';

import type { Env } from '../config/env.schema';
import { ClsService } from 'nestjs-cls';
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

import { extractDatabaseProblem } from './database-problem';
import { extractMiddlewareProblem } from './middleware-problem';
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
  /** From validated configuration, not `process.env`. */
  private readonly isProduction: boolean;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly logger: PinoLogger,
    private readonly cls: ClsService,
    config: ConfigService<Env, true>,
  ) {
    this.isProduction =
      config.get('NODE_ENV', { infer: true }) === 'production';
    this.logger.setContext(ProblemDetailsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    // No query string: it may carry a cedula or a medical record number.
    // `?? ''` after the split too: `String.split` is typed as possibly
    // undefined at an index, and an instance of `undefined` in the response
    // body would be worse than an empty one.
    const instance =
      String(httpAdapter.getRequestUrl(req) ?? '').split('?')[0] ?? '';
    const problem = this.toProblemDetails(exception, instance, req);

    /**
     * THE STATIC MESSAGE IS MANDATORY, not a style choice.
     *
     * If you hand pino an object with `err` and no message, it uses
     * `err.message` as `msg`. And `msg` is a string: serializers never touch
     * it. Nest's 404 carries the full URL — query string included — in its
     * message, so without this the cedula in the URL would leak.
     */
    /**
     * A 4xx does NOT carry the error object.
     *
     * An expired token is a continuous, entirely normal event in production,
     * and writing a stack for each one costs money and buries what matters.
     * The code and the route answer every question a 4xx raises; a 5xx is our
     * bug and needs everything.
     */
    if (problem.status >= 500) {
      this.logger.error(
        { err: exception, error_code: problem.code, status: problem.status },
        'request failed',
      );
    } else {
      this.logger.warn(
        { error_code: problem.code, status: problem.status, route: instance },
        'request rejected',
      );
    }

    /**
     * Nothing to do if the response has already started.
     *
     * `reply` throws when headers are sent, and it throws INSIDE the filter —
     * which loses the handler and takes the process with it. The request is
     * already lost; the process does not have to be.
     */
    if (res.headersSent) {
      this.logger.error(
        { error_code: problem.code },
        'error raised after the response had started',
      );
      return;
    }

    httpAdapter.setHeader?.(res, 'Content-Type', PROBLEM_CONTENT_TYPE);
    httpAdapter.reply(res, problem, problem.status);
  }

  private toProblemDetails(
    exception: unknown,
    instance: string,
    req: Request,
  ): ProblemDetails {
    /**
     * `traceId` is populated, and it is THE SAME id as the header.
     *
     * The type promised "the user reports the id and you find the trace" and
     * the body never carried it, while `genReqId` had already put one in the
     * response header. Filling it from the CLS id instead would have been
     * worse than leaving it empty: two different identifiers for one event,
     * with the user reading one and the logs holding the other.
     *
     * `req.id` is what pino-http assigned and what went out in
     * `X-Request-Id`. The CLS id is only a fallback for a path that never
     * reached the HTTP logger.
     */
    const requestId = (req as { id?: unknown }).id;
    const base = {
      instance,
      timestamp: new Date().toISOString(),
      traceId: typeof requestId === 'string' ? requestId : this.cls.getId(),
    };

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

    // Errors thrown by Express middleware, which run BEFORE NestJS sees the
    // request and therefore never become HttpException. The body-parser
    // rejecting an oversized payload is the one that matters today: it was
    // answering 500, so a client sending too much data was told the server had
    // broken rather than that the request was too big.
    const middlewareProblem = extractMiddlewareProblem(exception);
    if (middlewareProblem) {
      const { code, title } = this.describeHttpStatus(middlewareProblem.status);
      return {
        ...base,
        type: `${BASE_TYPE}/http-${middlewareProblem.status}`,
        title,
        status: middlewareProblem.status,
        code,
      };
    }

    // A rule the database enforced. Checked before the generic branch because
    // these are NOT server failures: the appointment overlap, the cedula check
    // digit and the immutability of a signed note all reached the client as a
    // 500, telling the user the system had broken when it had just protected
    // the record.
    const dbProblem = extractDatabaseProblem(exception);
    if (dbProblem) {
      return {
        ...base,
        type: `${BASE_TYPE}/${dbProblem.slug}`,
        title: dbProblem.title,
        status: dbProblem.status,
        code: dbProblem.code,
        // No `detail`, in ANY environment. PostgreSQL puts the offending row
        // in the error, and that row holds patient data.
        ...(dbProblem.errors ? { errors: dbProblem.errors } : {}),
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
