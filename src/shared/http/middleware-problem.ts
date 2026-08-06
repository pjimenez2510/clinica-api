import { HttpStatus } from '@nestjs/common';

/**
 * Errors raised by Express middleware, before NestJS is involved.
 *
 * Body parsing, CORS and cookie handling run as platform middleware, so what
 * they throw is never an `HttpException` and fell through to the generic 500.
 * The visible consequence: a request whose body exceeded the limit was told
 * the SERVER had failed, when the request was simply too large — and the
 * client has no way to learn it should send less.
 *
 * These follow the `http-errors` convention that Express itself uses: a
 * numeric `status` and `expose: true` for anything meant to reach the client.
 * Reading that contract is what keeps this from being a list of error names
 * that grows every time a middleware is added.
 */
interface HttpErrorLike {
  status?: unknown;
  statusCode?: unknown;
  expose?: unknown;
}

export function extractMiddlewareProblem(
  exception: unknown,
): { status: HttpStatus } | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;

  const candidate = exception as HttpErrorLike;
  const status = candidate.status ?? candidate.statusCode;

  // `expose` is how http-errors marks a message as safe for the client, and
  // it is only ever true for 4xx. A 5xx from middleware is our problem, not
  // the caller's, and belongs in the generic branch with no detail leaked.
  if (candidate.expose !== true) return undefined;
  if (typeof status !== 'number' || status < 400 || status >= 500) {
    return undefined;
  }

  return { status };
}
