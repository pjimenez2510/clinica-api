import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { PAYMENT_METHODS } from '../domain/invoice';

/**
 * B7 — the contract of what the clinic changes without a deploy (BI-140 to
 * BI-147). Percentages travel as decimal strings, like every amount (BI-001).
 */

const SRI_CODE_MESSAGE =
  'Elija la forma de pago del SRI: 01, 15, 16, 17, 18, 19, 20 o 21';

export const createPaymentMethodSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Escriba el nombre del medio de pago')
    .max(60, 'El nombre tiene como máximo 60 caracteres'),
  // BI-144. The same closed list the invoice admits (BI-170).
  sriCode: z.enum(PAYMENT_METHODS, { error: SRI_CODE_MESSAGE }),
});
/** Body of POST /billing/payment-methods. */
export class CreatePaymentMethodDto extends createZodDto(
  createPaymentMethodSchema,
) {}

export const updatePaymentMethodSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Escriba el nombre del medio de pago')
    .max(60, 'El nombre tiene como máximo 60 caracteres')
    .optional(),
  sriCode: z.enum(PAYMENT_METHODS, { error: SRI_CODE_MESSAGE }).optional(),
  active: z.boolean().optional(),
});
/** Body of PATCH /billing/payment-methods/:paymentMethodId. */
export class UpdatePaymentMethodDto extends createZodDto(
  updatePaymentMethodSchema,
) {}

const lastChangeSchema = z
  .object({
    at: z.string(),
    by: z.object({ id: z.uuid(), name: z.string() }),
  })
  .nullable();

const paymentMethodResponseSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sriCode: z.enum(PAYMENT_METHODS),
  active: z.boolean(),
  displayOrder: z.number().int(),
  /** BI-147. `null` = as the installation brought it. */
  lastChange: lastChangeSchema,
});
export class PaymentMethodDto extends createZodDto(
  paymentMethodResponseSchema,
) {}
export class PaymentMethodListDto extends createZodDto(
  z.object({ items: z.array(paymentMethodResponseSchema) }),
) {}
export type PaymentMethodResponse = z.infer<typeof paymentMethodResponseSchema>;

/** 0 to 100, at most two decimals, as a string (BI-001). */
const percentageSchema = z
  .string()
  .trim()
  .regex(
    /^\d{1,3}(\.\d{1,2})?$/,
    'Escriba un porcentaje con hasta dos decimales',
  )
  .refine(
    (value) => Number(value) <= 100,
    'El límite no puede pasar del 100 %',
  );

export const setDiscountLimitSchema = z.object({
  maxDiscountPercentage: percentageSchema,
});
/** Body of PUT /billing/discount-limits/:roleId. */
export class SetDiscountLimitDto extends createZodDto(setDiscountLimitSchema) {}

const discountLimitResponseSchema = z.object({
  roleId: z.uuid(),
  roleCode: z.string(),
  roleName: z.string(),
  roleActive: z.boolean(),
  /** BI-141. `'0.00'` for a role with no limit assigned: closed by default. */
  maxDiscountPercentage: z.string(),
  lastChange: lastChangeSchema,
});
export class DiscountLimitDto extends createZodDto(
  discountLimitResponseSchema,
) {}
export class DiscountLimitListDto extends createZodDto(
  z.object({ items: z.array(discountLimitResponseSchema) }),
) {}
export type DiscountLimitResponse = z.infer<typeof discountLimitResponseSchema>;
