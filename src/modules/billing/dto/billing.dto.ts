import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  type ClinicalDate,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import { explicitFlag } from '../../../shared/http/query-flag';

import {
  BUYER_IDENTIFICATION_TYPES,
  MAX_VOUCHER_SERVICE_CODE,
  PAYMENT_METHODS,
} from '../domain/invoice';
import {
  PAYER_KINDS,
  SERVICE_KINDS,
  VISIT_KINDS,
} from '../domain/billing.repository';
import {
  CHARGE_ORIGINS,
  PROPOSAL_SKIP_REASONS,
} from '../domain/charge-proposal';

/**
 * The billing contract, requests and responses.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ EVERY MONETARY VALUE IS A STRING, IN BOTH DIRECTIONS. BI-001.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `JSON.parse` turns `19.90` into an IEEE-754 double, so an amount serialised
 * as a JSON number has already lost precision before the client reads it. That
 * is not purism: it is the difference between the sum of the printed lines
 * matching the total of the invoice and not matching it once in a thousand.
 * The schema below refuses anything that is not a plain decimal with at most
 * two places, so a client that sends `19.899999` is told what to fix instead
 * of being silently rounded.
 *
 * Responses are schemas too, not bare interfaces: `clinica-web` generates its
 * types from the OpenAPI document, and a response Swagger cannot see arrives
 * on the other side typed as `never`.
 *
 * Wording follows ADR-005: a complete sentence, capitalised, no trailing
 * period, telling the user what to do.
 */

/** Two decimals at most, and never in scientific notation. */
const MONEY_PATTERN = /^\d{1,10}(\.\d{1,2})?$/;
/** `charge_item.quantity` is `numeric(10,3)`. */
const QUANTITY_PATTERN = /^\d{1,7}(\.\d{1,3})?$/;

/**
 * BI-001. A monetary field: a decimal string, refused with a message that
 * names the field rather than silently rounded.
 */
export const money = (label: string) =>
  z
    .string({ error: `${label} es obligatorio` })
    .regex(MONEY_PATTERN, `${label} se escribe en dólares con dos decimales, por ejemplo 19.90`); // prettier-ignore

/**
 * A `YYYY-MM-DD` field branded as a `ClinicalDate`. The parser's exception
 * becomes a per-field issue carrying `message`, so a date that does not exist
 * is answered like any other validation error.
 */
export const clinicalDateField = (message: string) =>
  z.iso.date(message).transform((value, ctx): ClinicalDate => {
    try {
      return parseClinicalDate(value);
    } catch {
      ctx.addIssue({ code: 'custom', message });
      return z.NEVER;
    }
  });

// ───────────────────────────────────────────────────────────────────────────
// The catalogue
// ───────────────────────────────────────────────────────────────────────────

export const catalogueQuerySchema = z.object({
  /** BI-014. Deactivated services stay readable, on request. */
  includeInactive: explicitFlag,
});
/** Query of GET /billing/payers. */
export class CatalogueQueryDto extends createZodDto(catalogueQuerySchema) {}

/** BI-282 (D-220 §3). The page sizes the list offers, and nothing else. */
export const SERVICE_PAGE_SIZES = [20, 50, 100] as const;

export const serviceQuerySchema = z.object({
  /** Name or code, without accents or case. */
  q: z.string().trim().max(120).optional(),
  kind: z
    .enum(SERVICE_KINDS, {
      error: 'Tipos admitidos: CONSULTATION, PROCEDURE, LAB_EXAM, IMAGING, SUPPLY, OTHER', // prettier-ignore
    })
    .optional(),
  specialtyId: z.uuid('Seleccione una especialidad').optional(),
  /** BI-014. Deactivated services stay readable, on request. */
  includeInactive: explicitFlag,
  page: z.coerce
    .number({ error: 'La página es un número' })
    .int('La página es un número entero')
    .min(1, 'La página empieza en 1')
    .default(1),
  pageSize: z.coerce
    .number()
    .refine(
      (size) => (SERVICE_PAGE_SIZES as readonly number[]).includes(size),
      'Muestre 20, 50 o 100 por página',
    )
    .default(20),
});
/** Query of GET /billing/services (BI-282). */
export class ServiceQueryDto extends createZodDto(serviceQuerySchema) {}

export const awaitingCheckoutQuerySchema = z.object({
  /** D-119. Also the ones older than seven days, still unsettled. */
  includeOlder: explicitFlag,
});
/** Query of GET /billing/sites/:siteId/encounters/awaiting-checkout. */
export class AwaitingCheckoutQueryDto extends createZodDto(
  awaitingCheckoutQuerySchema,
) {}

/** BI-284. The order extension of an exam, an imaging study or a procedure. */
const orderExtensionSchema = z.object({
  form010Section: z.string().trim().max(60).nullish(),
  specimenType: z.string().trim().max(80).nullish(),
  patientPreparation: z.string().trim().max(500).nullish(),
  turnaroundHours: z
    .number()
    .int('Las horas de entrega son un número entero')
    .min(1, 'Las horas de entrega empiezan en 1')
    .max(32767)
    .nullish(),
  requiresFasting: z.boolean().optional(),
  fastingHours: z
    .number()
    .int('Las horas de ayuno son un número entero')
    .min(1, 'El ayuno va de 1 a 24 horas')
    .max(24, 'El ayuno va de 1 a 24 horas')
    .nullish(),
  performedExternally: z.boolean().optional(),
  externalLabName: z.string().trim().max(160).nullish(),
  externalLabCode: z.string().trim().max(64).nullish(),
});

/** BI-171. The voucher's `codigoPrincipal` is mandatory and admits 25. */
const serviceCode = z
  .string()
  .trim()
  .min(1, 'Indique el código del servicio')
  .max(
    MAX_VOUCHER_SERVICE_CODE,
    'El código admite hasta 25 caracteres, lo que acepta el SRI',
  );

/**
 * BI-280. The kind first, then only what that kind carries; and its self-pay
 * price, which is a row of the self-pay list and never a column of the
 * service (BI-006).
 *
 * The rest of «only what that kind carries» is the service's (BI-279,
 * BI-284), not this schema's: a rule that lived only here would stop existing
 * the moment a seed writes underneath it.
 */
export const createServiceSchema = z.object({
  kind: z.enum(SERVICE_KINDS, {
    error: 'Elija el tipo: consulta, procedimiento, examen, imagen, insumo u otro', // prettier-ignore
  }),
  /** Proposed from the kind and the name when absent (BI-280). */
  code: serviceCode.optional(),
  name: z.string().trim().min(1, 'Escriba el nombre del servicio').max(200),
  /** D-228. Required; zero is a price. */
  selfPayAmount: money('El precio particular'),
  /** BI-285. Nomenclature only; for a procedure, its tariff code (BI-286). */
  mspCode: z.string().trim().max(32).nullish(),
  /** Absent: the health-services rate (SRI code 0), unreviewed (D-A-006). */
  taxRateId: z.uuid('Seleccione el IVA que aplica').optional(),
  /** BI-279. Only on a consultation. */
  specialtyId: z.uuid('Seleccione la especialidad').optional(),
  durationMinutes: z
    .number({ error: 'Escriba la duración en minutos' })
    .int('La duración es un número entero de minutos')
    .optional(),
  visitKind: z
    .enum(VISIT_KINDS, { error: 'Elija primera vez o control' })
    .nullish(),
  /** BI-284. On an exam or imaging study always; on a procedure, if ordered. */
  exam: orderExtensionSchema.nullish(),
});
/** Body of POST /billing/services (`billing:price-manage`, clinic-wide). */
export class CreateServiceDto extends createZodDto(createServiceSchema) {}

/** A partial update; the kind is not here: it does not change (BI-278). */
export const updateServiceSchema = z.object({
  code: serviceCode.optional(),
  name: z.string().trim().min(1, 'Escriba el nombre del servicio').max(200).optional(), // prettier-ignore
  mspCode: z.string().trim().max(32).nullish(),
  taxRateId: z.uuid('Seleccione el IVA que aplica').optional(),
  active: z.boolean().optional(),
  specialtyId: z.uuid('Seleccione la especialidad').optional(),
  durationMinutes: z
    .number({ error: 'Escriba la duración en minutos' })
    .int('La duración es un número entero de minutos')
    .optional(),
  visitKind: z
    .enum(VISIT_KINDS, { error: 'Elija primera vez o control' })
    .nullish(),
  /** BI-284. Fields to change; `null` stops a procedure being ordered. */
  exam: orderExtensionSchema.partial().nullish(),
});
/** Body of PATCH /billing/services/:serviceId. */
export class UpdateServiceDto extends createZodDto(updateServiceSchema) {}

export const createPayerSchema = z.object({
  // D-057: the sentences of the form, so both sides say the same thing.
  code: z.string().trim().min(1, 'Escriba el código del pagador').max(32),
  name: z.string().trim().min(1, 'Escriba el nombre del pagador').max(160),
  /**
   * BI-030. A CLASSIFICATION, not the payer list. There can be many private
   * insurers and every one of them is `PRIVATE_INSURANCE`; adding one is a row,
   * never a deploy.
   */
  kind: z.enum(PAYER_KINDS, {
    error: 'Valores admitidos: SELF_PAY, PUBLIC_NETWORK, PRIVATE_INSURANCE, COMPANY_AGREEMENT', // prettier-ignore
  }),
  ruc: z.string().trim().max(13).nullish(),
  agreementReference: z.string().trim().max(120).nullish(),
});
/** Body of POST /billing/payers. An institutional payer without a RUC is answered with `PAYER_RUC_REQUIRED` (BI-034), and a malformed one with `INVALID_RUC` (BI-036), not by this schema. */
export class CreatePayerDto extends createZodDto(createPayerSchema) {}

export const updatePayerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Escriba el nombre del pagador')
    .max(160)
    .optional(),
  ruc: z.string().trim().max(13).nullish(),
  agreementReference: z.string().trim().max(120).nullish(),
  active: z.boolean().optional(),
});
/** Body of PATCH /billing/payers/:payerId. */
export class UpdatePayerDto extends createZodDto(updatePayerSchema) {}

/**
 * BI-044. «A partir de esta fecha cuesta otra cosa» — the only operation.
 *
 * There is no `priceId` to edit, and no `validTo`: the end of the current
 * validity is decided by the start of the next one, which is what keeps the
 * two from disagreeing and what `price_temporal_unique` refuses to let happen
 * any other way.
 */
export const setPriceSchema = z.object({
  serviceId: z.uuid('Seleccione el servicio'),
  amount: money('El precio'),
  effectiveFrom: clinicalDateField('Indique desde cuándo rige, en formato AAAA-MM-DD'), // prettier-ignore
});
/** Body of POST /billing/payers/:payerId/prices; the payer is the route's. */
export class SetPriceDto extends createZodDto(setPriceSchema) {}

/** BI-230. Correcting the amount of a price in force or still to come. */
export const correctPriceSchema = z.object({
  amount: money('El precio'),
});
/** Body of PATCH /billing/prices/:priceId. */
export class CorrectPriceDto extends createZodDto(correctPriceSchema) {}

// ───────────────────────────────────────────────────────────────────────────
// The account and the charge
// ───────────────────────────────────────────────────────────────────────────

/**
 * BI-070. The site is NOT here: it is the `:siteId` of the route, so the guard
 * can check the caller's scope over it before any pipe runs (BI-131). Guards
 * see route parameters and an unvalidated body, which is why an authorisation
 * decision may only be taken on the former.
 */
export const openAccountSchema = z.object({
  patientId: z.uuid('Seleccione el paciente'),
  /** BI-054. A counter sale has no encounter, and that is admitted. */
  encounterId: z.uuid().nullish(),
  /** BI-070. Decided on arrival, not at the cashier. */
  payerId: z.uuid('Indique quién paga'),
});
/** Body of POST /billing/sites/:siteId/accounts. */
export class OpenAccountDto extends createZodDto(openAccountSchema) {}

export const changePayerSchema = z.object({
  payerId: z.uuid('Indique quién paga'),
});
/**
 * Body of PATCH /billing/sites/:siteId/accounts/:accountId. The open charges
 * are repriced with the new payer; a billed one refuses it (BI-198).
 */
export class ChangePayerDto extends createZodDto(changePayerSchema) {}

export const closeAccountSchema = z.object({
  /**
   * BI-237. Por qué no se cobra —«Control sin costo», «Cortesía»—, exigido
   * sólo cuando no hay nada facturado; con algo facturado no se guarda. El
   * vacío lo decide el servicio, que es quien sabe si hay facturado.
   */
  noChargeReason: z
    .string()
    .max(200, 'El motivo no puede superar 200 caracteres')
    .optional(),
});
/**
 * Body of POST /billing/sites/:siteId/accounts/:accountId/close. Optional as
 * a whole: an account with something invoiced closes with no body at all.
 */
export class CloseAccountDto extends createZodDto(
  // No body at all is the same as `{}`: an account with something invoiced
  // closes with none, as it always did.
  z.preprocess((body) => body ?? {}, closeAccountSchema),
) {}

export const addChargeSchema = z.object({
  serviceId: z.uuid('Seleccione el servicio'),
  encounterId: z.uuid().nullish(),
  /**
   * BI-052. THE DATE OF THE ACT, not of the typing, and it is required rather
   * than defaulted to today: on almost every day the two coincide, which is
   * exactly why a default would hide the case that matters — a visit from
   * three months ago invoiced now.
   */
  serviceDate: clinicalDateField('Indique la fecha del servicio en formato AAAA-MM-DD'), // prettier-ignore
  quantity: z
    .string()
    .regex(QUANTITY_PATTERN, 'La cantidad admite hasta tres decimales')
    .default('1'),
});
/**
 * Body of POST …/accounts/:accountId/charges. No amount: the unit price is
 * resolved by the service date and copied onto the charge (BI-050).
 */
export class AddChargeDto extends createZodDto(addChargeSchema) {}

/**
 * BI-150. «Enviar a caja»: abre o recupera la cuenta de una atención y propone
 * lo que se hizo.
 *
 * `payerId` es OPCIONAL a propósito, y no por comodidad: una atención que ya
 * tiene cuenta abierta ya decidió quién paga, y volver a mandarlo abriría la
 * puerta a cambiarlo desde una pantalla que no es la de cambiar pagador
 * (BI-033). Sólo hace falta la primera vez, y sin él el servidor responde
 * `PAYER_REQUIRED_TO_OPEN_ACCOUNT` nombrando el campo.
 *
 * ⚠️ NO LLEVA `patientId`. El paciente sale de la atención: aceptarlo aquí
 * dejaría abrir la cuenta de la visita de una persona sobre la ficha de otra, y
 * eso acaba en una factura con la cédula equivocada, que desde 2026 ya no se
 * puede ni anular.
 */
export const checkoutSchema = z.object({
  payerId: z.uuid('Indique quién paga').optional(),
});
/** Body of POST /billing/sites/:siteId/encounters/:encounterId/checkout. */
export class CheckoutDto extends createZodDto(checkoutSchema) {}

/**
 * BI-055, BI-195. Quitar un cargo NO exige motivo (D-126.1): todavía no salió
 * de caja. Si llega, se guarda. Vacío es lo mismo que ausente.
 */
export const voidChargeSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500, 'El motivo admite hasta 500 caracteres')
    .transform((value) => (value === '' ? undefined : value))
    .optional(),
});
/** Body of POST …/charges/:chargeId/void; it may be empty. */
export class VoidChargeDto extends createZodDto(voidChargeSchema) {}

/**
 * BI-197. Lo que se corrige de un cargo sin facturar; lo que no viene se queda
 * como está. Ni el precio ni el estado: el precio sale de la lista en la fecha
 * de servicio, y editar no confirma.
 */
export const editChargeSchema = z
  .object({
    serviceId: z.uuid('Seleccione el servicio').optional(),
    serviceDate: clinicalDateField('Indique la fecha del servicio en formato AAAA-MM-DD').optional(), // prettier-ignore
    quantity: z
      .string()
      .regex(QUANTITY_PATTERN, 'La cantidad admite hasta tres decimales')
      .optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.serviceId !== undefined ||
      body.serviceDate !== undefined ||
      body.quantity !== undefined,
    { message: 'Indique qué cambia del cargo' },
  );
/** Body of PATCH …/accounts/:accountId/charges/:chargeId. */
export class EditChargeDto extends createZodDto(editChargeSchema) {}

/**
 * BI-060 to BI-066. Un descuento sobre una línea confirmada: en dólares
 * (`amount`) o en porcentaje (`percentage`), nunca los dos; `amount: "0.00"`
 * lo quita. `authorisedById` sólo hace falta por encima del límite propio
 * (BI-063); dentro, se ignora. Quien lo aplica es la sesión, nunca el cuerpo.
 */
export const applyDiscountSchema = z
  .object({
    amount: money('El descuento').optional(),
    percentage: z
      .string()
      .trim()
      .regex(
        /^\d{1,3}(\.\d{1,2})?$/,
        'Escriba un porcentaje con hasta dos decimales',
      ) // prettier-ignore
      .refine(
        (value) => Number(value) <= 100,
        'El descuento no puede pasar del 100 %',
      ) // prettier-ignore
      .optional(),
    reason: z
      .string()
      .trim()
      .max(300, 'El motivo admite hasta 300 caracteres')
      .optional(),
    authorisedById: z.uuid('Elija quién lo autoriza').optional(),
  })
  .strict()
  .refine(
    (body) => (body.amount === undefined) !== (body.percentage === undefined),
    {
      message: 'Indique el descuento en dólares o en porcentaje',
      path: ['amount'],
    },
  );
/** Body of POST …/accounts/:accountId/charges/:chargeId/discount. */
export class ApplyDiscountDto extends createZodDto(applyDiscountSchema) {}

/** BI-245. Lo que el diálogo sabe antes de pedir nada. */
const discountPolicySchema = z.object({
  /** BI-062. El mayor de los límites de quien pide en esta sede; `'0.00'` sin ninguno. */
  maxDiscountPercentage: z.string(),
  /** BI-245. Otras personas con `billing:discount-override` en la sede. */
  authorisers: z.array(z.object({ userId: z.uuid(), name: z.string() })),
});
export class DiscountPolicyDto extends createZodDto(discountPolicySchema) {}
export type DiscountPolicyResponse = z.infer<typeof discountPolicySchema>;

/** BI-198. Query of GET …/accounts/:accountId/repricing. */
export const repricingQuerySchema = z.object({
  payerId: z.uuid('Indique quién paga'),
});
export class RepricingQueryDto extends createZodDto(repricingQuerySchema) {}

/**
 * BI-198. Lo que la confirmación del cambio de pagador muestra. `newTotal` es
 * `null` cuando a alguna línea le falta precio con el pagador nuevo: el cambio
 * se rechazaría con `PRICE_NOT_FOUND`.
 */
const repricingResponseSchema = z.object({
  currentTotal: z.string(),
  newTotal: z.string().nullable(),
  lines: z.array(
    z.object({ chargeId: z.uuid(), unitAmount: z.string().nullable() }),
  ),
});
export class RepricingDto extends createZodDto(repricingResponseSchema) {}
export type RepricingResponse = z.infer<typeof repricingResponseSchema>;

export const accountQuerySchema = z.object({
  patientId: z.uuid().optional(),
  status: z.enum(['OPEN', 'SETTLED', 'CANCELLED']).optional(),
});
/** Query of GET /billing/sites/:siteId/accounts. */
export class AccountQueryDto extends createZodDto(accountQuerySchema) {}

// ───────────────────────────────────────────────────────────────────────────
// The invoice
// ───────────────────────────────────────────────────────────────────────────

/**
 * BI-080, BI-081. The receiver, and the exception that is never a default.
 *
 * ⚠️ THERE IS NO `isFinalConsumer: boolean` IN THIS CONTRACT, AND THERE NEVER
 * WILL BE. Issuing to «Consumidor Final» destroys the patient's
 * personal-expense rebate and, since 2026, cannot even be voided (D-A-007) —
 * so it arrives as an OBJECT carrying a confirmation and a reason, both
 * required, or it does not arrive. A boolean would be one keystroke away from
 * being the comfortable default this requirement exists to prevent, and the
 * warning that lived only on a screen would disappear the moment somebody
 * called this route from a cashier shortcut.
 *
 * Every field of the ordinary branch is optional HERE on purpose: the absence
 * is answered by `INVOICE_RECEIVER_REQUIRED` naming the field (BI-080), which
 * is a code the client can branch on, rather than by a generic
 * `VALIDATION_FAILED`.
 */
export const receiverSchema = z.object({
  identificationType: z.enum(BUYER_IDENTIFICATION_TYPES).optional(),
  identification: z.string().trim().max(20).optional(),
  name: z.string().trim().max(300).optional(),
  email: z.email('Revise el correo del receptor').max(320).optional(),
  finalConsumer: z
    .object({
      confirmed: z.boolean().optional(),
      /** BI-201: admitted for older clients and ignored; never demanded. */
      reason: z.string().trim().max(300).optional(),
    })
    .optional(),
});

export const issueInvoiceSchema = z.object({
  accountId: z.uuid('Seleccione la cuenta que se factura'),
  emissionPointId: z.uuid('Seleccione el punto de emisión'),
  receiver: receiverSchema,
  /** BI-170, D-092. Asked, never defaulted: SRI table 24. */
  paymentMethod: z.enum(PAYMENT_METHODS, {
    error: 'Indique la forma de pago',
  }),
  /**
   * BI-184. Los cargos pendientes que caja vio al anunciar el total. Si otra
   * caja los cambió entretanto, `INVOICE_CHARGES_CHANGED` y no se emite.
   */
  chargeIds: z.array(z.uuid()).optional(),
  /**
   * BI-184, BI-197. El total que caja vio. Un cargo editado en el sitio
   * conserva su id: sin el total, la factura saldría por un importe que nadie
   * vio. Si no coincide, `INVOICE_CHARGES_CHANGED`.
   */
  expectedTotal: money('El total').optional(),
  /**
   * BI-247. «Cobrado ahora»: the money came in with this method, and the
   * invoice is born paid. Absent, it is born with its whole amount owed.
   */
  payment: z
    .object({
      paymentMethodId: z.uuid('Elija el medio de pago'),
      reference: z.string().trim().max(100).optional(),
    })
    .optional(),
});
/** Body of POST /billing/sites/:siteId/invoices. */
export class IssueInvoiceDto extends createZodDto(issueInvoiceSchema) {}

/**
 * BI-216, SRI-090. «Editar» on an invoice the SRI returned or did not
 * authorise: the receiver and the payment method, under the same rules as the
 * issuance — and nothing else of it.
 */
export const resubmitInvoiceSchema = z.object({
  receiver: receiverSchema,
  paymentMethod: z.enum(PAYMENT_METHODS, {
    error: 'Indique la forma de pago',
  }),
});
/** Body of POST /billing/sites/:siteId/invoices/:invoiceId/resubmission. */
export class ResubmitInvoiceDto extends createZodDto(resubmitInvoiceSchema) {}

/**
 * BI-233, BI-234. The filters an invoice list and a credit-note list share:
 * the number or the buyer, and the days of issue, both ends included.
 */
export const issuedDocumentQueryShape = {
  /** `123`, `000000123`, `001-001-000000123`, a buyer's name or identification. */
  search: z.string().trim().max(300).optional(),
  from: clinicalDateField('Indique una fecha válida').optional(),
  to: clinicalDateField('Indique una fecha válida').optional(),
  page: z.coerce.number().int().min(1).default(1),
  /** ESTANDAR-UI §12.7: 20, 50 or 100. */
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export const invoiceQuerySchema = z.object({
  accountId: z.uuid().optional(),
  ...issuedDocumentQueryShape,
  /** BI-259. Only those with a balance still owed (D-200.3). */
  owed: explicitFlag,
});
/** Query of GET /billing/sites/:siteId/invoices. */
export class InvoiceQueryDto extends createZodDto(invoiceQuerySchema) {}

// ───────────────────────────────────────────────────────────────────────────
// Responses
// ───────────────────────────────────────────────────────────────────────────

const taxRateResponseSchema = z.object({
  id: z.uuid(),
  sriCode: z.string(),
  name: z.string(),
  /** `null` for «no objeto» and «exento», which are NOT synonyms of 0%. */
  percentage: z.string().nullable(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
});
/** Response of GET /billing/tax-rates (BI-020, BI-021). */
export class TaxRateDto extends createZodDto(
  z.object({ items: z.array(taxRateResponseSchema) }),
) {}
/** What the controller maps into; inferred, so it cannot drift from the published schema. */
export type TaxRateResponse = z.infer<typeof taxRateResponseSchema>;

/** BI-189. One price of a service in one payer's list. */
const servicePriceSchema = z.object({
  priceId: z.uuid(),
  payer: z.object({
    id: z.uuid(),
    name: z.string(),
    kind: z.enum(PAYER_KINDS),
  }),
  /** BI-001: a string, never a number. */
  amount: z.string(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
  /** In force on today's date in Ecuador. */
  inForce: z.boolean(),
});
export class ServicePriceListDto extends createZodDto(
  z.object({ items: z.array(servicePriceSchema) }),
) {}
export type ServicePriceResponse = z.infer<typeof servicePriceSchema>;

/** BI-024. The rate the reviewer saw: the review signs that one or none. */
export const markTaxReviewedSchema = z.object({
  taxRateId: z.uuid({ error: 'Indique la tarifa que revisó' }),
});
/** Body of POST /billing/services/:serviceId/tax-review. */
export class MarkTaxReviewedDto extends createZodDto(markTaxReviewedSchema) {}

/** BI-256. «Exige consentimiento 024», on or off. */
export const markWrittenConsentSchema = z.object({
  required: z.boolean({ error: 'Indique si exige el consentimiento 024' }),
});
/** Body of POST /billing/services/:serviceId/written-consent. */
export class MarkWrittenConsentDto extends createZodDto(
  markWrittenConsentSchema,
) {}

const orderExtensionResponseSchema = z.object({
  form010Section: z.string().nullable(),
  specimenType: z.string().nullable(),
  patientPreparation: z.string().nullable(),
  turnaroundHours: z.number().int().nullable(),
  requiresFasting: z.boolean(),
  fastingHours: z.number().int().nullable(),
  performedExternally: z.boolean(),
  externalLabName: z.string().nullable(),
  externalLabCode: z.string().nullable(),
});

const serviceResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  /** BI-278. Fixed once created. */
  kind: z.enum(SERVICE_KINDS),
  /** BI-279. Present exactly on a consultation. */
  consultation: z
    .object({
      specialtyId: z.uuid(),
      specialtyName: z.string(),
      durationMinutes: z.number().int(),
      visitKind: z.enum(VISIT_KINDS).nullable(),
    })
    .nullable(),
  /** BI-284. Present when it is ordered on a service order. */
  exam: orderExtensionResponseSchema.nullable(),
  /** BI-285. «Código MSP»; for a procedure, its tariff code (BI-286). */
  mspCode: z.string().nullable(),
  taxRateId: z.uuid(),
  taxSriCode: z.string(),
  taxPercentage: z.string().nullable(),
  active: z.boolean(),
  /** BI-256. Whether its procedure demands the form 024, and who last set it. */
  writtenConsent: z.object({
    required: z.boolean(),
    setAt: z.iso.datetime().nullable(),
    setBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  }),
  /** BI-022 to BI-024. Who checked the tax rate and when; `null` = pending. */
  taxReview: z
    .object({
      reviewedAt: z.iso.datetime(),
      reviewedBy: z.object({ id: z.uuid(), name: z.string() }),
    })
    .nullable(),
});
/** One service. */
export class ServiceDto extends createZodDto(serviceResponseSchema) {}
/** Return type of `toServiceResponse`, inferred from the published schema. */
export type ServiceResponse = z.infer<typeof serviceResponseSchema>;

/** BI-282. A price in force today in one list. */
const currentPriceSchema = z.object({
  priceListId: z.uuid(),
  payerId: z.uuid(),
  priceId: z.uuid(),
  /** BI-001: a string, never a number. */
  amount: z.string(),
  validFrom: z.string(),
});
const serviceListItemSchema = serviceResponseSchema.extend({
  /**
   * BI-282. In force today, in the self-pay list and every active payer's.
   * A list missing here has no price in force there.
   */
  prices: z.array(currentPriceSchema),
});
/** Response of GET /billing/services (BI-282): one page and the total. */
export class ServiceListDto extends createZodDto(
  z.object({
    items: z.array(serviceListItemSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  }),
) {}
export type ServiceListItemResponse = z.infer<typeof serviceListItemSchema>;

/** BI-283. One analyte of an ordered service, with its ranges in force. */
const serviceAnalyteSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  unit: z.string().nullable(),
  valueType: z.string(),
  decimals: z.number().int().nullable(),
  allowedValues: z.unknown(),
  loincCode: z.string().nullable(),
  active: z.boolean(),
  position: z.number().int(),
  isReflex: z.boolean(),
  ranges: z.array(
    z.object({
      id: z.uuid(),
      sex: z.string().nullable(),
      ageMinDays: z.number().int().nullable(),
      ageMaxDays: z.number().int().nullable(),
      rangeKind: z.string(),
      low: z.string().nullable(),
      high: z.string().nullable(),
      text: z.string().nullable(),
    }),
  ),
});
const serviceDetailSchema = serviceResponseSchema.extend({
  /** BI-283. Its analytes in print order; empty when it is not ordered. */
  analytes: z.array(serviceAnalyteSchema),
  /** BI-189, BI-283. Its prices in every payer's list, every validity. */
  prices: z.array(servicePriceSchema),
});
/** Response of GET /billing/services/:serviceId (BI-283). */
export class ServiceDetailDto extends createZodDto(serviceDetailSchema) {}
export type ServiceDetailResponse = z.infer<typeof serviceDetailSchema>;

const payerResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(PAYER_KINDS),
  ruc: z.string().nullable(),
  agreementReference: z.string().nullable(),
  agreementValidTo: z.string().nullable(),
  active: z.boolean(),
});
/** One payer, and the list of GET /billing/payers. */
export class PayerDto extends createZodDto(payerResponseSchema) {}
export class PayerListDto extends createZodDto(
  z.object({ items: z.array(payerResponseSchema) }),
) {}
/** Return type of the payer mapper, inferred from the published schema. */
export type PayerResponse = z.infer<typeof payerResponseSchema>;

const priceResponseSchema = z.object({
  id: z.uuid(),
  serviceId: z.uuid(),
  amount: z.string(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
});
/** Response of POST /billing/payers/:payerId/prices: the validity just opened. */
export class PriceDto extends createZodDto(priceResponseSchema) {}

/**
 * BI-230. The corrected price, and how many charges not yet invoiced keep the
 * amount it had: they are not rewritten (BI-050).
 */
const correctedPriceResponseSchema = priceResponseSchema.extend({
  openChargesAtPreviousAmount: z.number().int(),
});
/** Response of PATCH /billing/prices/:priceId. */
export class CorrectedPriceDto extends createZodDto(
  correctedPriceResponseSchema,
) {}
const priceListResponseSchema = z.object({
  priceListId: z.uuid(),
  payerId: z.uuid(),
  publiclyListed: z.boolean(),
  items: z.array(priceResponseSchema),
});
/** Response of GET /billing/payers/:payerId/prices (BI-040, BI-041). */
export class PriceListResponseDto extends createZodDto(
  priceListResponseSchema,
) {}
/** Controller return types, inferred from the published schemas. */
export type PriceResponse = z.infer<typeof priceResponseSchema>;
export type PriceListResponse = z.infer<typeof priceListResponseSchema>;

/**
 * BI-183, D-078. Who the account or the visit is for: names, document and HC.
 * Identity and nothing clinical, read without opening the chart (BI-133).
 */
const patientIdentitySchema = z.object({
  id: z.uuid(),
  mrn: z.string(),
  familyName: z.string(),
  secondFamilyName: z.string().nullable(),
  givenName: z.string(),
  secondGivenName: z.string().nullable(),
  /** `null` for a newborn with no document yet: the HC alone identifies them. */
  document: z
    .object({
      type: z.enum(['CEDULA', 'PASSPORT', 'REFUGEE_CARD', 'FOREIGN_ID']),
      value: z.string(),
    })
    .nullable(),
});
export type PatientIdentityResponse = z.infer<typeof patientIdentitySchema>;

const accountResponseSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  patientId: z.uuid(),
  patient: patientIdentitySchema,
  encounterId: z.uuid().nullable(),
  payerId: z.uuid(),
  priceListId: z.uuid(),
  status: z.enum(['OPEN', 'SETTLED', 'CANCELLED']),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  /** BI-237. Por qué se cerró sin cobrar nada, si fue así. */
  noChargeReason: z.string().nullable(),
});
/** One account, and the list of GET /billing/sites/:siteId/accounts. */
export class AccountDto extends createZodDto(accountResponseSchema) {}
export class AccountListDto extends createZodDto(
  z.object({ items: z.array(accountResponseSchema) }),
) {}
/** Return type of the account mapper, inferred from the published schema. */
export type AccountResponse = z.infer<typeof accountResponseSchema>;

/** BI-181 to BI-183. One ended visit caja still has to look at. */
const awaitingCheckoutSchema = z.object({
  encounterId: z.uuid(),
  status: z.enum(['DISCHARGED', 'DISCONTINUED', 'COMPLETED']),
  endedAt: z.iso.datetime(),
  /** BI-182. `false`: nothing was done in it, so nothing will be proposed. */
  clinicallyAttended: z.boolean(),
  patient: patientIdentitySchema,
  /** The open account it already has, or `null` if it never went to caja. */
  account: z.object({ id: z.uuid(), status: z.literal('OPEN') }).nullable(),
  /** BI-194. Exámenes emitidos sin cargo tras liquidar una cuenta; `0` si no tiene liquidada. */
  unchargedExams: z.number().int().nonnegative(),
});
/** Response of GET /billing/sites/:siteId/encounters/awaiting-checkout. */
export class AwaitingCheckoutListDto extends createZodDto(
  z.object({
    items: z.array(awaitingCheckoutSchema),
    /** D-119. Las de más de siete días que siguen sin liquidar, contadas. */
    olderCount: z.number().int(),
  }),
) {}
export type AwaitingCheckoutResponse = z.infer<typeof awaitingCheckoutSchema>;

/**
 * A charge, AS IT WAS FROZEN. Everything here is a copy taken on the day of
 * service; nothing is looked up when this is served (BI-051).
 */
/** A person named on a line: id and display name, nothing else. */
const personRefSchema = z.object({ id: z.uuid(), name: z.string() });

/**
 * BI-260. Another document as a line or an invoice names it: its id, its
 * printed number (BI-235) and its status before the SRI.
 */
const documentRefSchema = z.object({
  id: z.uuid(),
  documentNumber: z.string(),
  status: z.string(),
});

const chargeResponseSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  serviceId: z.uuid(),
  encounterId: z.uuid().nullable(),
  serviceDate: z.string(),
  quantity: z.string(),
  unitAmount: z.string(),
  /** BI-050. How the amount is EXPLAINED years later. */
  resolvedPriceId: z.uuid().nullable(),
  serviceDisplay: z.string(),
  taxSriCode: z.string(),
  taxPercentage: z.string().nullable(),
  discountAmount: z.string(),
  discountReason: z.string().nullable(),
  /** BI-066, SC-021. Quién puso el descuento y cuándo; `null` sin descuento. */
  discountAppliedBy: personRefSchema.nullable(),
  discountAppliedAt: z.iso.datetime().nullable(),
  /** BI-063. Quién lo autorizó por encima del límite, y cuándo; `null` si cupo. */
  discountAuthorisedBy: personRefSchema.nullable(),
  discountAuthorisedAt: z.iso.datetime().nullable(),
  status: z.enum(['PLANNED', 'BILLABLE', 'NOT_BILLABLE', 'BILLED', 'CANCELLED']), // prettier-ignore
  /**
   * BI-153. DE DÓNDE VIENE LA LÍNEA, que es lo que quien cobra tiene que poder
   * leer sin adivinarlo: «la consulta», «un procedimiento de la atención», «un
   * examen pedido» o «lo tecleé yo».
   */
  origin: z.enum(CHARGE_ORIGINS),
  encounterProcedureId: z.uuid().nullable(),
  serviceOrderItemId: z.uuid().nullable(),
  /** BI-055. Por qué NO se cobra, cuando alguien lo quitó. */
  voidedAt: z.iso.datetime().nullable(),
  voidReason: z.string().nullable(),
  /** BI-169, BI-218. The invoice that billed it; `null` until it is billed. */
  invoiceId: z.uuid().nullable(),
  /** BI-214. «Corrección»: the credited charge this line bills again. */
  correctsChargeItemId: z.uuid().nullable(),
  /**
   * BI-074, BI-260. La nota de crédito no rechazada que la acreditó: la línea
   * ya no cuenta en el total de la cuenta. `null` si nada la acreditó.
   */
  creditNote: documentRefSchema.nullable(),
  /** BI-058. Derived from the four frozen values above, never stored. */
  lineTotal: z.string(),
  lineTax: z.string(),
});
/** Response of adding, confirming and voiding a charge. The inferred type below is what the mapper returns. */
export class ChargeDto extends createZodDto(chargeResponseSchema) {}
export type ChargeResponse = z.infer<typeof chargeResponseSchema>;

export const totalsSchema = z.object({
  subtotalTaxed: z.string(),
  subtotalUntaxed: z.string(),
  discountTotal: z.string(),
  taxTotal: z.string(),
  total: z.string(),
});

const statementSchema = z.object({
  account: accountResponseSchema,
  charges: z.array(chargeResponseSchema),
  /** BI-074. DERIVED from the charges, never a column. */
  totals: totalsSchema,
  /**
   * BI-152. De ese total, CUÁNTO SIGUE SIENDO UNA PROPUESTA.
   *
   * Los cargos derivados nacen `PLANNED` y la factura sólo se lleva los
   * `BILLABLE`. Sin esta cifra la pantalla enseña ochenta y cinco dólares y la
   * factura sale por treinta, que es la clase de diferencia que se descubre
   * cuando ya no se puede corregir.
   */
  proposedTotals: totalsSchema,
  /** BI-184. Lo que llevaría una factura emitida ahora: lo confirmado sin facturar. */
  invoiceableTotals: totalsSchema,
  /**
   * BI-249. Lo que el paciente debe en la sede, todas sus facturas juntas;
   * negativo, lo que se le debe a él.
   */
  patientBalance: z.string(),
  /** BI-192. Las órdenes de exámenes de la atención que nadie emitió. */
  draftOrders: z.array(
    z.object({
      orderId: z.uuid(),
      orderedByName: z.string(),
      savedAt: z.iso.datetime(),
    }),
  ),
  /**
   * BI-203. La consulta que ya no corresponde a la atención: se corrigió
   * primera vez/subsecuente y el cargo no se pudo re-tarifar solo (sin precio,
   * o ya facturado). `null` cuando no hay nada que decir.
   */
  consultationOutdated: z
    .object({ chargeId: z.uuid(), billed: z.boolean() })
    .nullable(),
  /**
   * BI-243. Los cargos de procedimiento que ya no corresponden a la atención:
   * el procedimiento se quitó (`RETRACTED`) o cambió su prestación o su
   * cantidad (`CHANGED`), y caja ya los había confirmado o facturado.
   */
  proceduresOutdated: z.array(
    z.object({
      chargeId: z.uuid(),
      billed: z.boolean(),
      reason: z.enum(['RETRACTED', 'CHANGED']),
    }),
  ),
  /**
   * BI-236. El estado de la atención de la cuenta (`null` sin atención): una
   * `DISCHARGED` se cierra con la cuenta, y la pantalla lo dice antes.
   */
  encounterStatus: z
    .enum([
      'OPEN',
      'ON_HOLD',
      'DISCHARGED',
      'COMPLETED',
      'DISCONTINUED',
      'ENTERED_IN_ERROR',
    ]) // prettier-ignore
    .nullable(),
  /**
   * BI-236, D-189. Si cerrar la cuenta cierra también la atención: tiene el
   * alta y ninguna orden de exámenes en borrador (D-189).
   */
  closesEncounter: z.boolean(),
});
/** Response of GET /billing/sites/:siteId/accounts/:accountId (BI-074). The inferred type below is what the controller returns. */
export class AccountStatementDto extends createZodDto(statementSchema) {}
export type AccountStatementResponse = z.infer<typeof statementSchema>;

/**
 * BI-151, BI-155. Lo que el paso a caja propuso, y lo que NO pudo proponer.
 *
 * ⚠️ LO OMITIDO VIAJA CON IDENTIFICADORES Y UN CÓDIGO, NUNCA CON EL NOMBRE DE
 * LA PRESTACIÓN (BI-007). El nombre de un examen puede ser tan revelador como
 * un diagnóstico, y esta respuesta pasa por registros. La pantalla traduce el
 * código al español; el identificador es lo que permite actuar.
 */
const skippedActSchema = z.object({
  origin: z.enum(['CONSULTATION', 'PROCEDURE', 'EXAM']),
  encounterProcedureId: z.uuid().nullable(),
  serviceOrderItemId: z.uuid().nullable(),
  reason: z.enum(PROPOSAL_SKIP_REASONS),
});

const checkoutResponseSchema = z.object({
  statement: statementSchema,
  /** Vacío en la segunda pulsación: la idempotencia se ve, no se supone. */
  raisedChargeIds: z.array(z.uuid()),
  skipped: z.array(skippedActSchema),
});
/** Response of the checkout route. The inferred type below is what the controller returns. */
export class CheckoutResponseDto extends createZodDto(checkoutResponseSchema) {}
export type CheckoutResponse = z.infer<typeof checkoutResponseSchema>;

/** SRI-060, SRI-088. A document's electronic voucher before the SRI. */
export const electronicStateSchema = z.object({
  voucherId: z.uuid(),
  state: z.enum([
    'PREPARED',
    'SIGNED',
    'RECEIVED',
    'AUTHORISED',
    'RETURNED',
    'NOT_AUTHORISED',
  ]),
  blockedReason: z.string().nullable(),
  accessKey: z.string(),
  authorisedAt: z.iso.datetime().nullable(),
  deliveryStatus: z.string().nullable(),
  lastMessage: z
    .object({ identifier: z.string(), message: z.string() })
    .nullable(),
});

const invoiceResponseSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  siteId: z.uuid(),
  emissionPointId: z.uuid(),
  sequential: z.string(),
  /** D-185.1, BI-235. The printed number, `001-002-000000123`. */
  documentNumber: z.string(),
  accessKey: z.string().nullable(),
  buyerIdentificationType: z.enum(BUYER_IDENTIFICATION_TYPES),
  buyerIdentification: z.string(),
  buyerName: z.string(),
  buyerEmail: z.string().nullable(),
  isFinalConsumer: z.boolean(),
  totals: totalsSchema,
  status: z.enum(['DRAFT', 'ISSUED', 'AUTHORISED', 'REJECTED', 'VOIDED']),
  /** BI-170. `null` only on invoices issued before it was asked. */
  paymentMethod: z.enum(PAYMENT_METHODS).nullable(),
  issuedAt: z.iso.datetime().nullable(),
  authorisedAt: z.iso.datetime().nullable(),
  /** BI-103, BI-249. Collected, not reversed. */
  paidTotal: z.string(),
  /** BI-103. Credited by notes the SRI did not reject. */
  creditedTotal: z.string(),
  /** BI-260. Sus notas de crédito con su estado —también las rechazadas, que no acreditan—, de la más antigua a la más reciente. */
  creditNotes: z.array(documentRefSchema),
  /** BI-260. Las facturas que vuelven a cobrar lo que esas notas acreditaron. */
  replacedBy: z.array(documentRefSchema.extend({ accountId: z.uuid() })),
  /** BI-103. Total − credited − paid; negative is owed back to the patient. */
  balance: z.string(),
  /**
   * SRI-060. Its electronic voucher before the SRI; `null` while there is none
   * (the installation lacks a datum, SRI-008, or the sweep has not run yet).
   */
  electronic: electronicStateSchema.nullable(),
});
/** One invoice, and the list of GET /billing/sites/:siteId/invoices. */
export class InvoiceDto extends createZodDto(invoiceResponseSchema) {}
export class InvoiceListDto extends createZodDto(
  z.object({
    items: z.array(invoiceResponseSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  }),
) {}
/** Return type of the invoice mapper, inferred from the published schema. */
export type InvoiceResponse = z.infer<typeof invoiceResponseSchema>;

/** BI-082. What the screen offers, and what it never applies by itself. */
const receiverProposalSchema = z.object({
  identificationType: z.enum(BUYER_IDENTIFICATION_TYPES).nullable(),
  identification: z.string().nullable(),
  name: z.string().nullable(),
  /** BI-270. The living chart whose contact «Actualizar la ficha» corrects. */
  patientId: z.uuid().nullable(),
  /** BI-270. The chart's e-mail, offered and never applied by the server. */
  email: z.string().nullable(),
  /** BI-271. Who already paid for this patient at this site, newest first. */
  frequentBuyers: z.array(
    z.object({
      identificationType: z.enum(BUYER_IDENTIFICATION_TYPES),
      identification: z.string(),
      name: z.string(),
      email: z.string().nullable(),
    }),
  ),
});
/** Response of GET …/accounts/:accountId/invoice-receiver. The inferred type below is what the controller returns. */
export class ReceiverProposalDto extends createZodDto(receiverProposalSchema) {}
export type ReceiverProposalResponse = z.infer<typeof receiverProposalSchema>;
