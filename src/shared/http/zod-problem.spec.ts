import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { extractZodError, zodIssuesToFieldErrors } from './zod-problem';

/** Parses and returns the resulting ZodError. */
function failureOf(schema: z.ZodType, input: unknown): unknown {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? undefined : result.error;
}

describe('zodIssuesToFieldErrors', () => {
  it('reports every failing field, not only the first', () => {
    // A form that highlights one error at a time makes the user submit five
    // times to discover five problems.
    const schema = z.object({
      email: z.email('correo inválido'),
      password: z.string().min(1, 'obligatoria'),
    });

    const errors = zodIssuesToFieldErrors(
      failureOf(schema, { email: 'nope', password: '' }),
    );

    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.field)).toEqual(['email', 'password']);
  });

  it('keeps the message written in the schema', () => {
    const schema = z.object({ email: z.email('ingresa un correo válido') });
    const [error] = zodIssuesToFieldErrors(failureOf(schema, { email: 'x' }));

    expect(error?.message).toBe('ingresa un correo válido');
  });

  it('maps Zod codes to STABLE codes', () => {
    // Zod renamed its internal codes between v3 and v4. Mapping means our
    // public contract does not move when a dependency does.
    const schema = z.object({
      email: z.email(),
      name: z.string().min(5),
      age: z.number(),
    });

    const errors = zodIssuesToFieldErrors(
      failureOf(schema, { email: 'x', name: 'ab', age: 'not a number' }),
    );

    expect(errors.map((e) => e.code)).toEqual([
      'INVALID_FORMAT',
      'TOO_SMALL',
      'INVALID_TYPE',
    ]);
  });

  it('renders nested paths in dot notation with array indices', () => {
    // The client uses this string to focus the offending input.
    const schema = z.object({
      items: z.array(z.object({ quantity: z.number().min(1) })),
    });

    const [error] = zodIssuesToFieldErrors(
      failureOf(schema, { items: [{ quantity: 0 }] }),
    );

    expect(error?.field).toBe('items[0].quantity');
  });

  it('labels a root-level failure instead of returning an empty path', () => {
    const [error] = zodIssuesToFieldErrors(
      failureOf(z.object({}).strict(), 'not an object'),
    );
    expect(error?.field).toBe('(root)');
  });

  it('returns an empty array for anything that is not a Zod error', () => {
    // The filter calls this on every HttpException; it must never throw.
    expect(zodIssuesToFieldErrors(undefined)).toEqual([]);
    expect(zodIssuesToFieldErrors(new Error('boom'))).toEqual([]);
    expect(zodIssuesToFieldErrors({ issues: 'not an array' })).toEqual([]);
  });
});

describe('extractZodError', () => {
  it('recognises anything exposing getZodError, without importing nestjs-zod', () => {
    // Duck typing on purpose: the shared HTTP layer must not depend on the
    // validation library, so swapping Zod later does not mean rewriting the
    // error contract.
    const zodError = failureOf(z.string(), 1);
    expect(extractZodError({ getZodError: () => zodError })).toBe(zodError);
  });

  it('returns undefined for an ordinary exception', () => {
    expect(extractZodError(new Error('boom'))).toBeUndefined();
    expect(extractZodError({})).toBeUndefined();
  });
});
