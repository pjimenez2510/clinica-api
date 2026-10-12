import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The order's contract.
 *
 * Responses are schemas too and not bare interfaces: `clinica-web` generates
 * its types from the OpenAPI document, and a response Swagger cannot see
 * arrives on the other side typed as `never`.
 *
 * Wording follows ADR-005: a complete sentence, capitalised, no trailing
 * period, telling the user what to do.
 */

const CATEGORY = z.enum(['LABORATORY', 'IMAGING', 'PROCEDURE']);
const PRIORITY = z.enum(['ROUTINE', 'URGENT', 'STAT']);
const STATUS = z.enum(['DRAFT', 'ISSUED', 'DISCARDED']);
const ITEM_STATUS = z.enum([
  'REQUESTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);

/**
 * ORD-002, ORD-004. One line of the request: the service (BI-284).
 *
 * ⚠️ NO `conceptId`. The TARIFF concept, when there is one, comes from the
 * service's MSP code, resolved by the server on the clinical date of the
 * attention. `.strict()` so a client still sending one —or the old
 * `examDefinitionId`— hears about it.
 */
export const orderLineSchema = z
  .object({
    serviceId: z.uuid('Seleccione el examen en el catálogo'),
  })
  .strict();

/**
 * ORD-001 to ORD-005, ORD-095, ORD-096. Composing one order as a draft, and
 * rewriting that draft: the same body for both.
 *
 * ⚠️ THERE IS NO `orderedById` FIELD (ORD-001). The order is signed by the
 * professional OF THE ATTENTION, read from the attention itself: an id in the
 * request is an order somebody can file under a colleague's name.
 *
 * ⚠️ AND THERE IS NO AMOUNT, IN EITHER DIRECTION (ORD-002). One line of the
 * order is one line of the invoice, and what it costs comes from the price
 * list of the payer on the service date, in `billing`. A price accepted here
 * would be a clinical row deciding an economic fact.
 */
export const placeOrderSchema = z.object({
  category: CATEGORY,
  priority: PRIORITY.default('ROUTINE'),
  /** What the laboratory needs to know: «paciente en tratamiento con …». */
  clinicalNoteText: z
    .string()
    .trim()
    .max(2000, 'La indicación clínica no puede superar 2000 caracteres')
    .optional(),
  /**
   * ORD-003. AT LEAST ONE, and the upper bound is generous on purpose: a
   * pre-operative panel of a dozen exams is one order, and splitting it would
   * split the worklist entry a person works.
   */
  items: z
    .array(orderLineSchema)
    .min(1, 'Añada al menos un examen a la orden')
    .max(40, 'Una orden no puede llevar más de 40 exámenes'),
});
/** Body of POST /encounters/:encounterId/orders and PUT /orders/:orderId. */
export class PlaceOrderDto extends createZodDto(placeOrderSchema) {}

/** ORD-002. One line as a client reads it. */
export const orderItemSchema = z.object({
  id: z.uuid(),
  /** ORD-002. Frozen when it was ordered, like the CIE-10 of a diagnosis. */
  testCode: z.string(),
  testDisplay: z.string(),
  /** ORD-004. `null` when the service had no MSP code in force that day. */
  conceptId: z.uuid().nullable(),
  status: ITEM_STATUS,
  /** `null` means «no ha vuelto». It is what the whole worklist is built on. */
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** ORD-131. Some result already came back for it: it is not cancelled. */
  hasResults: z.boolean(),
});

/**
 * ORD-009. One order as a client reads it.
 *
 * `number` is ORD-006, the legal number of the A.M. 00002393 art. 43:
 * consecutive per site and printed on the request. The technical id is served
 * because a client needs to address the row; it is NOT the legal number.
 */
export const serviceOrderSchema = z.object({
  id: z.uuid(),
  encounterId: z.uuid(),
  siteId: z.uuid(),
  patientId: z.uuid(),
  orderedById: z.uuid(),
  /**
   * ORD-181. The revision to send back in `If-Match` when correcting or
   * issuing the draft. Changes with every write of the draft (ORD-182).
   */
  revision: z.number().int().positive(),
  /**
   * ORD-006, ORD-098. Consecutive per site; assigned by the database when the
   * order is issued. `null` while it is a draft.
   */
  number: z.number().int().positive().nullable(),
  /** ORD-095 to ORD-099. Only a `DRAFT` is rewritten, issued or discarded. */
  status: STATUS,
  /** ORD-099. When the draft was discarded. */
  discardedAt: z.iso.datetime().nullable(),
  category: CATEGORY,
  priority: PRIORITY,
  clinicalNoteText: z.string().nullable(),
  /**
   * ORD-158, ORD-159. The chart's sex as it was when the order was issued,
   * frozen by the database: the header of the order says this one, on screen
   * and on the PDF, however the chart is corrected afterwards. `null` while a
   * draft or discarded. The PDF —readable with the same permission— already
   * prints it.
   */
  patientSex: z.enum(['MALE', 'FEMALE', 'INTERSEX', 'UNKNOWN']).nullable(),
  /** Maintained by `trg_service_order_item_pending`; never written by a client. */
  pendingItems: z.number().int(),
  /** The issue instant once issued; while a draft, when it was composed. */
  requestedAt: z.iso.datetime(),
  items: z.array(orderItemSchema),
});
/** Response of placing an order, reading one, and cancelling one of its lines. */
export class ServiceOrderDto extends createZodDto(serviceOrderSchema) {}

/**
 * ORD-118. Response of POST /orders/:orderId/correct: the issued order with its
 * live lines cancelled, and the new draft that carries them.
 */
/**
 * DOC-109. Whether the PDF that replaces the annulled one was filed: `true`
 * filed; `false` there was one and it COULD NOT be filed —the screen warns,
 * because the archive still holds the PDF without the mark—; `null` there was
 * no PDF to replace.
 */
const documentArchivedSchema = z.boolean().nullable();

/** ORD-007. What annulling an exam answers: the order, and its PDF (DOC-109). */
export const orderWithCancelledItemSchema = serviceOrderSchema.extend({
  documentArchived: documentArchivedSchema,
});
export class OrderWithCancelledItemDto extends createZodDto(
  orderWithCancelledItemSchema,
) {}

export const correctedOrderSchema = z.object({
  cancelled: serviceOrderSchema,
  draft: serviceOrderSchema,
  documentArchived: documentArchivedSchema,
});
export class CorrectedOrderDto extends createZodDto(correctedOrderSchema) {}

export const serviceOrderListSchema = z.object({
  items: z.array(serviceOrderSchema),
});
/** Response of GET /encounters/:encounterId/orders. */
export class ServiceOrderListDto extends createZodDto(serviceOrderListSchema) {}

/**
 * ORD-020 to ORD-025, ORD-081. What the pending worklist is asked for.
 *
 * `cedula` is the paper path: the person has the laboratory report in hand and
 * needs the orders of THAT chart. It resolves to a chart first and refuses
 * when none holds it — it never creates one (ORD-080).
 */
export const pendingOrdersQuerySchema = z.object({
  category: CATEGORY.optional(),
  examCode: z
    .string()
    .trim()
    .max(32, 'El código del examen es demasiado largo')
    .optional(),
  cedula: z
    .string()
    .trim()
    .regex(/^\d{10}$/, 'La cédula tiene diez dígitos')
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200, 'No se pueden listar más de 200 pendientes de una vez')
    .default(100),
});
/** Query of GET /orders/pending. */
export class PendingOrdersQueryDto extends createZodDto(
  pendingOrdersQuerySchema,
) {}

/**
 * ORD-020 to ORD-024. One entry of the worklist.
 *
 * ⚠️ WHAT IS NOT HERE IS THE REQUIREMENT (ORD-024): no diagnosis, no reason for
 * the visit, and no patient name — save on the cedula path (ORD-026). The list
 * is opened by everybody with `record:read` over the site and leaves no audit
 * row per entry (ORD-092).
 */
export const pendingOrderSchema = z.object({
  orderId: z.uuid(),
  /** ORD-006. What a report that comes back on paper quotes. */
  orderNumber: z.number().int().positive(),
  itemId: z.uuid(),
  siteId: z.uuid(),
  patientId: z.uuid(),
  encounterId: z.uuid(),
  orderedById: z.uuid(),
  category: CATEGORY,
  priority: PRIORITY,
  testCode: z.string(),
  testDisplay: z.string(),
  requestedAt: z.iso.datetime(),
  /** ORD-021. Counted on the calendar of Ecuador, never on the session's. */
  waitingDays: z.number().int(),
  /**
   * ORD-022. `null` is «no hay plazo comprometido» and is NOT `false`: an exam
   * whose turnaround nobody wrote down must not be reported as «va bien».
   */
  overdue: z.boolean().nullable(),
  dueAt: z.iso.datetime().nullable(),
  /**
   * ORD-026, D-068 C. Only when the worklist was asked for by cedula; `null`
   * on the plain worklist, which carries no identity (ORD-024).
   */
  patientName: z.string().nullable(),
});
/** One worklist entry; no route returns it alone, it is the row of `PendingOrderListDto`. */
export class PendingOrderDto extends createZodDto(pendingOrderSchema) {}

export const pendingOrderListSchema = z.object({
  items: z.array(pendingOrderSchema),
});
/** Response of GET /orders/pending. */
export class PendingOrderListDto extends createZodDto(pendingOrderListSchema) {}

/** Response types the controllers return, inferred from the schemas Swagger publishes. */
export type ServiceOrderResponse = z.infer<typeof serviceOrderSchema>;
export type ServiceOrderListResponse = z.infer<typeof serviceOrderListSchema>;
export type CorrectedOrderResponse = z.infer<typeof correctedOrderSchema>;
export type OrderWithCancelledItemResponse = z.infer<
  typeof orderWithCancelledItemSchema
>;
export type PendingOrderListResponse = z.infer<typeof pendingOrderListSchema>;

/** ORD-115. A draft its signer left behind in an attention no longer open. */
export const staleDraftSchema = z.object({
  orderId: z.uuid(),
  /** ORD-181. What `If-Match` carries when it is issued from this list. */
  revision: z.number().int().positive(),
  encounterId: z.uuid(),
  encounterStatus: z.enum(['OPEN', 'ON_HOLD', 'DISCHARGED', 'COMPLETED', 'DISCONTINUED', 'ENTERED_IN_ERROR']), // prettier-ignore
  encounterStartedAt: z.iso.datetime(),
  patientName: z.string(),
  category: CATEGORY,
  items: z.array(z.object({ testCode: z.string(), testDisplay: z.string() })),
  savedAt: z.iso.datetime(),
  /** ORD-005. `false` in a terminal attention: it can only be discarded. */
  canIssue: z.boolean(),
});
export const staleDraftListSchema = z.object({
  items: z.array(staleDraftSchema),
});
/** Response of GET /orders/drafts/stale. */
export class StaleDraftListDto extends createZodDto(staleDraftListSchema) {}
export type StaleDraftListResponse = z.infer<typeof staleDraftListSchema>;
