import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { PAYMENT_METHODS } from '../domain/invoice';
import { clinicalDateField, money } from './billing.dto';

/**
 * Payments and the daily close of cash (B6). Every amount is a decimal string
 * (BI-001), and every message tells the cashier what to do (ADR-005).
 */

/** BI-248. Body of POST …/invoices/:invoiceId/payments. */
export const collectPaymentSchema = z.object({
  paymentMethodId: z.uuid('Elija el medio de pago'),
  /** Absent: the whole balance. */
  amount: money('El importe').optional(),
  /** The voucher or transfer number. */
  reference: z
    .string()
    .trim()
    .max(100, 'La referencia tiene hasta 100 caracteres')
    .optional(),
});
export class CollectPaymentDto extends createZodDto(collectPaymentSchema) {}

/** BI-102. Body of POST …/payments/:paymentId/reversal. */
export const reversePaymentSchema = z.object({
  /** D-126. From a short list, and never required. */
  reason: z
    .string()
    .trim()
    .max(200, 'El motivo tiene hasta 200 caracteres')
    .optional(),
});
export class ReversePaymentDto extends createZodDto(reversePaymentSchema) {}

/** BI-251. Query of GET …/cash-sessions/day; today in Guayaquil by default. */
export const cashDayQuerySchema = z.object({
  date: clinicalDateField('Indique una fecha válida').optional(),
});
export class CashDayQueryDto extends createZodDto(cashDayQuerySchema) {}

/** BI-105, BI-252. Body of POST …/cash-sessions/close. */
export const closeCashSessionSchema = z.object({
  date: clinicalDateField('Indique una fecha válida'),
  /** D-197.1. The cash counted in the drawer. */
  declaredCash: money('El efectivo contado'),
  /**
   * BI-255. The expected cash the screen showed. If a payment came in since,
   * `CASH_DAY_CHANGED` and nothing is closed.
   */
  expectedCash: money('El efectivo esperado').optional(),
  note: z
    .string()
    .trim()
    .max(300, 'La nota tiene hasta 300 caracteres')
    .optional(),
});
export class CloseCashSessionDto extends createZodDto(closeCashSessionSchema) {}

// ───────────────────────────────────────────────────────────────────────────
// Responses
// ───────────────────────────────────────────────────────────────────────────

const paymentResponseSchema = z.object({
  id: z.uuid(),
  invoiceId: z.uuid(),
  invoiceDocumentNumber: z.string(),
  buyerName: z.string(),
  paymentMethodId: z.uuid(),
  paymentMethodName: z.string(),
  sriCode: z.enum(PAYMENT_METHODS),
  amount: z.string(),
  reference: z.string().nullable(),
  receivedAt: z.iso.datetime(),
  /** BI-250. The Guayaquil day it belongs to. */
  cashDate: z.iso.date(),
  reversal: z
    .object({ at: z.iso.datetime(), reason: z.string().nullable() })
    .nullable(),
});
export class PaymentDto extends createZodDto(paymentResponseSchema) {}
export type PaymentResponse = z.infer<typeof paymentResponseSchema>;

const cashLineSchema = z.object({
  paymentMethodId: z.uuid(),
  methodName: z.string(),
  sriCode: z.enum(PAYMENT_METHODS),
  paymentCount: z.number().int(),
  amount: z.string(),
});

const cashSessionResponseSchema = z.object({
  id: z.uuid(),
  cashDate: z.iso.date(),
  closedAt: z.iso.datetime(),
  closedByName: z.string(),
  lines: z.array(cashLineSchema),
  collectedTotal: z.string(),
  expectedCash: z.string(),
  declaredCash: z.string(),
  /** Declared − expected: + over, − short. */
  difference: z.string(),
  pendingTotal: z.string(),
  pendingCount: z.number().int(),
  note: z.string().nullable(),
});
export class CashSessionDto extends createZodDto(cashSessionResponseSchema) {}
export type CashSessionResponse = z.infer<typeof cashSessionResponseSchema>;

const cashDayResponseSchema = z.object({
  date: z.iso.date(),
  /** Reversed ones included, with their reversal. */
  payments: z.array(paymentResponseSchema),
  lines: z.array(cashLineSchema),
  collectedTotal: z.string(),
  expectedCash: z.string(),
  /** What this cashier invoiced that day and is still owed. */
  pendingTotal: z.string(),
  pendingCount: z.number().int(),
  /** `null` while the day is open. */
  session: cashSessionResponseSchema.nullable(),
});
export class CashDayDto extends createZodDto(cashDayResponseSchema) {}
export type CashDayResponse = z.infer<typeof cashDayResponseSchema>;
