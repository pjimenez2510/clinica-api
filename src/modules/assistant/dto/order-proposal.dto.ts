import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * AS-103 to AS-111. The contract of the exams the assistant proposes.
 * Responses are schemas so `clinica-web` types them from OpenAPI. No exam
 * name of the model's travels: only the catalogue's (AS-104).
 */

const candidateSchema = z.object({
  /** The service to put on the order (ORD-002, BI-284). */
  serviceId: z.uuid(),
  code: z.string(),
  name: z.string(),
  /** ORD-097. The order it goes on. */
  category: z.enum(['LABORATORY', 'IMAGING']),
  /** AS-106. Why it cannot be accepted now, or null. */
  block: z.enum(['in-order']).nullable(),
});

/** P2. A section of the note, or a stretch of the conversation. */
const originSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('note'), section: z.string() }),
  z.object({
    kind: z.literal('transcript'),
    fromMs: z.number().int(),
    toMs: z.number().int(),
  }),
]);

const lineSchema = z.object({
  id: z.uuid(),
  /** The note's or the conversation's own sentence (P2). */
  quote: z.string(),
  origin: originSchema,
  /** AS-104, AS-105. Up to five; none shows only the sentence. */
  candidates: z.array(candidateSchema),
  status: z.enum([
    'PROPOSED',
    'ACCEPTED',
    'ACCEPTED_WITH_CHANGES',
    'DISCARDED',
  ]),
  serviceOrderId: z.uuid().nullable(),
  /** AS-109. The exam it was accepted as. */
  acceptedCode: z.string().nullable(),
  /** AS-029. Written by the demonstration script, not by a model. */
  demo: z.boolean(),
});

export const ordersOverviewSchema = z.object({
  lines: z.array(lineSchema),
  readAt: z.iso.datetime().nullable(),
  demo: z.boolean(),
});
/** Response of GET /encounters/:encounterId/assistant/orders. */
export class OrderProposalOverviewDto extends createZodDto(
  ordersOverviewSchema,
) {}

export const ordersReadingSchema = ordersOverviewSchema.extend({
  /** AS-107. How many exams this reading proposed: 0 is said on screen. */
  found: z.number().int(),
  /** Exams the model read whose sentence is not there: dropped. */
  dropped: z.number().int(),
});
/** Response of POST …/assistant/orders/read. */
export class OrderProposalReadingDto extends createZodDto(
  ordersReadingSchema,
) {}

export const linkOrderProposalSchema = z.object({
  /** The order the draft was saved as (ORD-095). */
  serviceOrderId: z.uuid({ message: 'Indique la orden guardada' }),
  lines: z
    .array(
      z.object({
        suggestionId: z.uuid(),
        /** The candidate the physician accepted. */
        serviceId: z.uuid(),
      }),
    )
    .min(1)
    .max(40),
});
/** Body of POST …/assistant/orders/link. */
export class LinkOrderProposalDto extends createZodDto(
  linkOrderProposalSchema,
) {}
