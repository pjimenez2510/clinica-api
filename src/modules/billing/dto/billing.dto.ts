import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  type ClinicalDate,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';
import { explicitFlag } from '../../../shared/http/query-flag';

import { BUYER_IDENTIFICATION_TYPES } from '../domain/invoice';
import { PAYER_KINDS } from '../domain/billing.repository';
import {
  CHARGE_ORIGINS,
  PROPOSAL_SKIP_REASONS,
} from '../domain/charge-proposal';
import { VISIT_SEQUENCES } from '../domain/clinical-acts.port';

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
const money = (label: string) =>
  z
    .string({ error: `${label} es obligatorio` })
    .regex(MONEY_PATTERN, `${label} se escribe en dólares con dos decimales, por ejemplo 19.90`); // prettier-ignore

/**
 * A `YYYY-MM-DD` field branded as a `ClinicalDate`. The parser's exception
 * becomes a per-field issue carrying `message`, so a date that does not exist
 * is answered like any other validation error.
 */
const clinicalDateField = (message: string) =>
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
/** Query of GET /billing/services and GET /billing/payers. */
export class CatalogueQueryDto extends createZodDto(catalogueQuerySchema) {}

/**
 * BI-006, BI-013. NO AMOUNT FIELD, AND THAT ABSENCE IS THE REQUIREMENT.
 *
 * A price on a service breaks the first day an insurer pays differently. The
 * tax rate, by contrast, IS a property of the service and is required here —
 * and required again in the service layer, because a rule enforced only at the
 * transport boundary stops existing the moment a seed writes underneath it.
 */
export const createServiceSchema = z.object({
  code: z.string().trim().min(1, 'Indique el código de la prestación').max(32),
  name: z.string().trim().min(1, 'Indique el nombre de la prestación').max(200),
  category: z.string().trim().min(1, 'Indique la categoría').max(60),
  /** BI-011. Nomenclature only: no amount is ever taken from the Tarifario. */
  tariffCode: z.string().trim().max(16).nullish(),
  taxRateId: z.uuid('Seleccione la tarifa de impuesto que aplica'),
});
/** Body of POST /billing/services (`billing:price-manage`, clinic-wide). */
export class CreateServiceDto extends createZodDto(createServiceSchema) {}

export const updateServiceSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(60).optional(),
  tariffCode: z.string().trim().max(16).nullish(),
  taxRateId: z.uuid('Seleccione la tarifa de impuesto que aplica').optional(),
  active: z.boolean().optional(),
  /**
   * BI-158. Declares this service to be THE CONSULTATION of a specialty.
   *
   * A PAIR OR `null`, never half of one, and it arrives as an object for the
   * same reason `finalConsumer` does: two independent optional fields would
   * let a client send the specialty and forget the sequence, and the refusal
   * would come from a database CHECK instead of from a field-level message.
   *
   * `null` clears it. Omitting it leaves whatever was there — a `PATCH` that
   * reset the mapping every time somebody renamed a service would take the
   * consultation off the proposal without anybody noticing.
   */
  consultation: z
    .object({
      specialtyId: z.uuid('Seleccione la especialidad'),
      visitSequence: z.enum(VISIT_SEQUENCES, {
        error: 'Valores admitidos: FIRST_TIME, SUBSEQUENT',
      }),
    })
    .nullish(),
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
  billableServiceId: z.uuid('Seleccione la prestación'),
  amount: money('El precio'),
  effectiveFrom: clinicalDateField('Indique desde cuándo rige, en formato AAAA-MM-DD'), // prettier-ignore
});
/** Body of POST /billing/payers/:payerId/prices; the payer is the route's. */
export class SetPriceDto extends createZodDto(setPriceSchema) {}

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
/** Body of PATCH /billing/sites/:siteId/accounts/:accountId: refused once the account has a charge (BI-033). */
export class ChangePayerDto extends createZodDto(changePayerSchema) {}

export const addChargeSchema = z.object({
  billableServiceId: z.uuid('Seleccione la prestación'),
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
 * BI-055. Quitar un cargo EXIGE UN MOTIVO, y el motivo se guarda.
 *
 * Texto libre y no un desplegable: un desplegable se rellena en piloto
 * automático y a los seis meses el 90 % de las anulaciones dicen «Otro». Lo
 * mismo que hace `amendment_reason` en la nota clínica.
 */
export const voidChargeSchema = z.object({
  reason: z
    .string({ error: 'Indique por qué no se cobra este cargo' })
    .trim()
    .min(3, 'Explique por qué no se cobra este cargo')
    .max(500),
});
/** Body of POST …/charges/:chargeId/void. */
export class VoidChargeDto extends createZodDto(voidChargeSchema) {}

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
      reason: z.string().trim().max(300).optional(),
    })
    .optional(),
});

export const issueInvoiceSchema = z.object({
  accountId: z.uuid('Seleccione la cuenta que se factura'),
  emissionPointId: z.uuid('Seleccione el punto de emisión'),
  receiver: receiverSchema,
});
/** Body of POST /billing/sites/:siteId/invoices. */
export class IssueInvoiceDto extends createZodDto(issueInvoiceSchema) {}

export const invoiceQuerySchema = z.object({
  accountId: z.uuid().optional(),
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

const serviceResponseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  category: z.string(),
  tariffCode: z.string().nullable(),
  taxRateId: z.uuid(),
  taxSriCode: z.string(),
  taxPercentage: z.string().nullable(),
  active: z.boolean(),
  /** BI-158. Which consultation this service IS, when it is one. */
  specialtyId: z.uuid().nullable(),
  visitSequence: z.enum(VISIT_SEQUENCES).nullable(),
});
/** One service, and the catalogue of GET /billing/services. */
export class ServiceDto extends createZodDto(serviceResponseSchema) {}
export class ServiceListDto extends createZodDto(
  z.object({ items: z.array(serviceResponseSchema) }),
) {}
/** Return type of `toServiceResponse`, inferred from the published schema. */
export type ServiceResponse = z.infer<typeof serviceResponseSchema>;

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
  billableServiceId: z.uuid(),
  amount: z.string(),
  validFrom: z.string(),
  validTo: z.string().nullable(),
});
/** Response of POST /billing/payers/:payerId/prices: the validity just opened. */
export class PriceDto extends createZodDto(priceResponseSchema) {}
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

const accountResponseSchema = z.object({
  id: z.uuid(),
  siteId: z.uuid(),
  patientId: z.uuid(),
  encounterId: z.uuid().nullable(),
  payerId: z.uuid(),
  priceListId: z.uuid(),
  status: z.enum(['OPEN', 'SETTLED', 'CANCELLED']),
  openedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
});
/** One account, and the list of GET /billing/sites/:siteId/accounts. */
export class AccountDto extends createZodDto(accountResponseSchema) {}
export class AccountListDto extends createZodDto(
  z.object({ items: z.array(accountResponseSchema) }),
) {}
/** Return type of the account mapper, inferred from the published schema. */
export type AccountResponse = z.infer<typeof accountResponseSchema>;

/**
 * A charge, AS IT WAS FROZEN. Everything here is a copy taken on the day of
 * service; nothing is looked up when this is served (BI-051).
 */
const chargeResponseSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  billableServiceId: z.uuid(),
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
  /** BI-058. Derived from the four frozen values above, never stored. */
  lineTotal: z.string(),
  lineTax: z.string(),
});
/** Response of adding, confirming and voiding a charge. The inferred type below is what the mapper returns. */
export class ChargeDto extends createZodDto(chargeResponseSchema) {}
export type ChargeResponse = z.infer<typeof chargeResponseSchema>;

const totalsSchema = z.object({
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

const invoiceResponseSchema = z.object({
  id: z.uuid(),
  accountId: z.uuid(),
  siteId: z.uuid(),
  emissionPointId: z.uuid(),
  sequential: z.string(),
  accessKey: z.string().nullable(),
  buyerIdentificationType: z.enum(BUYER_IDENTIFICATION_TYPES),
  buyerIdentification: z.string(),
  buyerName: z.string(),
  buyerEmail: z.string().nullable(),
  isFinalConsumer: z.boolean(),
  totals: totalsSchema,
  status: z.enum(['DRAFT', 'ISSUED', 'AUTHORISED', 'REJECTED', 'VOIDED']),
  issuedAt: z.iso.datetime().nullable(),
  authorisedAt: z.iso.datetime().nullable(),
});
/** One invoice, and the list of GET /billing/sites/:siteId/invoices. */
export class InvoiceDto extends createZodDto(invoiceResponseSchema) {}
export class InvoiceListDto extends createZodDto(
  z.object({ items: z.array(invoiceResponseSchema) }),
) {}
/** Return type of the invoice mapper, inferred from the published schema. */
export type InvoiceResponse = z.infer<typeof invoiceResponseSchema>;

/** BI-082. What the screen offers, and what it never applies by itself. */
const receiverProposalSchema = z.object({
  identificationType: z.enum(BUYER_IDENTIFICATION_TYPES).nullable(),
  identification: z.string().nullable(),
  name: z.string().nullable(),
});
/** Response of GET …/accounts/:accountId/invoice-receiver. The inferred type below is what the controller returns. */
export class ReceiverProposalDto extends createZodDto(receiverProposalSchema) {}
export type ReceiverProposalResponse = z.infer<typeof receiverProposalSchema>;
