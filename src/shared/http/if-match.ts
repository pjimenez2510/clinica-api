import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiResponse } from '@nestjs/swagger';

import { PreconditionRequiredError } from '../domain/errors/domain-error';

/**
 * EN-281, PR-121, ORD-181. The revision a writer read, as `If-Match: "<n>"`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE STRONG TAG, AND NOTHING ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * RFC 9110 §13.1.1 also admits a list of tags, `*` («any current version»)
 * and weak tags. None of them is what a screen that read a draft sends, and
 * `*` in particular is a way to write without having read — the very thing
 * this exists to stop. So anything but one quoted positive integer is the
 * same as no header: 428, «recargue y vuelva a intentarlo».
 *
 * The revision travels in the BODY of every draft too (`revision`), which is
 * where the screen reads it; there is no `ETag` response header to keep in
 * step with it.
 */
const STRONG_REVISION = /^"([1-9][0-9]{0,9})"$/;

export class RevisionRequiredError extends PreconditionRequiredError {
  readonly code = 'REVISION_REQUIRED';
  override readonly userTitle = 'Recargue la página y vuelva a intentarlo';

  constructor() {
    super('If-Match with the revision read is required');
  }
}

/** The revision in `If-Match`, or `REVISION_REQUIRED`. */
export function revisionFrom(header: string | undefined): number {
  const match = STRONG_REVISION.exec(header?.trim() ?? '');
  const revision = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(revision) || revision > 2_147_483_647) {
    throw new RevisionRequiredError();
  }
  return revision;
}

/** RFC 9457, as `problem-details.filter.ts` writes it; the client reads `code`. */
const PROBLEM = {
  type: 'object',
  required: ['type', 'title', 'status', 'code'],
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    code: { type: 'string', enum: ['RECORD_CHANGED', 'REVISION_REQUIRED'] },
  },
} satisfies NonNullable<Parameters<typeof ApiHeader>[0]['schema']>;

/** Documents the header in OpenAPI, so the generated client must send it. */
export function ApiIfMatch(): MethodDecorator {
  return applyDecorators(
    ApiHeader({
      name: 'If-Match',
      required: true,
      description: 'La revisión leída, entre comillas: `"3"`.',
    }),
    ApiResponse({
      status: 412,
      description:
        'Esto cambió en otra pestaña o lo cambió otra persona (`RECORD_CHANGED`).',
      content: { 'application/problem+json': { schema: PROBLEM } },
    }),
    ApiResponse({
      status: 428,
      description: 'Falta `If-Match` (`REVISION_REQUIRED`).',
      content: { 'application/problem+json': { schema: PROBLEM } },
    }),
  );
}
