import { describe, expect, it } from 'vitest';

import { extractMiddlewareProblem } from './middleware-problem';

describe('errors raised by Express middleware', () => {
  it('recognises the body parser rejecting an oversized payload', () => {
    // The real shape, taken from a 2 MB request against the running API. It
    // used to fall through to a 500: the client was told the server had
    // broken when the request was simply too large.
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      expose: true,
      type: 'entity.too.large',
    });

    expect(extractMiddlewareProblem(tooLarge)).toEqual({ status: 413 });
  });

  it('leaves a 5xx from middleware to the generic branch', () => {
    // `expose` is how http-errors marks a message as safe for the client, and
    // it is never true for a 5xx. Those are our problem, not the caller's, and
    // must not leak a message.
    const internal = Object.assign(new Error('boom'), {
      status: 500,
      expose: false,
    });

    expect(extractMiddlewareProblem(internal)).toBeUndefined();
  });

  it('ignores anything that is not an http-errors object', () => {
    expect(extractMiddlewareProblem(new Error('plain'))).toBeUndefined();
    expect(extractMiddlewareProblem(undefined)).toBeUndefined();
    expect(extractMiddlewareProblem({ status: 413 })).toBeUndefined();
    expect(
      extractMiddlewareProblem({ status: '413', expose: true }),
    ).toBeUndefined();
  });
});
