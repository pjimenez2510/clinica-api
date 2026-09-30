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
const ITEM_STATUS = z.enum([
  'REQUESTED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
]);

/**
 * ORD-002, ORD-004. One line of the request.
 *
 * ⚠️ TWO IDENTIFIERS WHERE THERE SHOULD BE ONE, and it is written down rather
 * than hidden: **falta esquema (ORD-004)**. `exam_definition` has no
 * `concept_id` and `service_order_item.concept_id` is `NOT NULL`, so the
 * tariff concept has to travel beside the orderable. The relation is fixed and
 * belongs on the exam; the day the column exists, `conceptId` leaves this
 * contract.
 */
export const orderLineSchema = z.object({
  examDefinitionId: z.uuid('Seleccione el examen en el catálogo'),
  conceptId: z.uuid('Seleccione la prestación en el tarifario'),
});

/**
 * ORD-001 to ORD-006. Emitting one order.
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
export class PlaceOrderDto extends createZodDto(placeOrderSchema) {}

/** ORD-002. One line as a client reads it. */
export const orderItemSchema = z.object({
  id: z.uuid(),
  /** ORD-002. Frozen when it was ordered, like the CIE-10 of a diagnosis. */
  testCode: z.string(),
  testDisplay: z.string(),
  conceptId: z.uuid(),
  status: ITEM_STATUS,
  /** `null` means «no ha vuelto». It is what the whole worklist is built on. */
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

/**
 * ORD-009. One order as a client reads it.
 *
 * ⚠️ NO `orderNumber`, AND ITS ABSENCE IS ORD-006 MADE VISIBLE. The A.M.
 * 00002393 art. 43 requires orders «codificadas de manera consecutiva» and
 * `service_order` has no such column. The technical id is served because a
 * client needs to address the row; it is NOT the legal number and is not
 * presented as one.
 */
export const serviceOrderSchema = z.object({
  id: z.uuid(),
  encounterId: z.uuid(),
  siteId: z.uuid(),
  patientId: z.uuid(),
  orderedById: z.uuid(),
  category: CATEGORY,
  priority: PRIORITY,
  clinicalNoteText: z.string().nullable(),
  /** Maintained by `trg_service_order_item_pending`; never written by a client. */
  pendingItems: z.number().int(),
  requestedAt: z.iso.datetime(),
  items: z.array(orderItemSchema),
});
export class ServiceOrderDto extends createZodDto(serviceOrderSchema) {}

export const serviceOrderListSchema = z.object({
  items: z.array(serviceOrderSchema),
});
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
export class PendingOrdersQueryDto extends createZodDto(
  pendingOrdersQuerySchema,
) {}

/**
 * ORD-020 to ORD-024. One entry of the worklist.
 *
 * ⚠️ WHAT IS NOT HERE IS THE REQUIREMENT (ORD-024): no diagnosis, no reason for
 * the visit, no patient name. The list is opened by everybody with
 * `record:read` over the site and leaves no audit row per entry (ORD-092).
 */
export const pendingOrderSchema = z.object({
  orderId: z.uuid(),
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
});
export class PendingOrderDto extends createZodDto(pendingOrderSchema) {}

export const pendingOrderListSchema = z.object({
  items: z.array(pendingOrderSchema),
});
export class PendingOrderListDto extends createZodDto(pendingOrderListSchema) {}

export type ServiceOrderResponse = z.infer<typeof serviceOrderSchema>;
export type ServiceOrderListResponse = z.infer<typeof serviceOrderListSchema>;
export type PendingOrderListResponse = z.infer<typeof pendingOrderListSchema>;
