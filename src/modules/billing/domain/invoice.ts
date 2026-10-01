import {
  Cedula,
  InvalidCedulaError,
} from '../../../shared/domain/value-objects/cedula.vo';
import {
  InvalidRucError,
  Ruc,
} from '../../../shared/domain/value-objects/ruc.vo';
import {
  FinalConsumerNotConfirmedError,
  InvoiceReceiverIsPayerError,
  InvoiceReceiverRequiredError,
} from './billing.errors';

/**
 * The invoice, and WHO IT IS MADE OUT TO — which is the half that costs the
 * patient real money.
 *
 * ⚠️ THIS FILE DELIBERATELY CONTAINS NO WAY TO CHANGE AN INVOICE. D-A-007:
 * the SRI does not allow modifying or deleting an authorised one, so this
 * system has no «editar factura», not on a screen and not on a route (BI-090).
 * The absence is the requirement. Correcting is a credit note, which is a
 * different act, with a different permission and a mandatory reason.
 */

/**
 * `codigoTipoIdentificacion` of the SRI's technical sheet (table 6).
 *
 * Kept as the SRI's own codes rather than as words of ours: they are what goes
 * into the voucher, and a translation layer between «cedula» and `05` is a
 * place for the mapping to be wrong in exactly one direction.
 */
export const BUYER_IDENTIFICATION_TYPES = ['04', '05', '06', '07', '08'] as const; // prettier-ignore
/** One of `BUYER_IDENTIFICATION_TYPES`. */
export type BuyerIdentificationType =
  (typeof BUYER_IDENTIFICATION_TYPES)[number];

/** The SRI's own placeholder. `invoice_final_consumer_identification` demands it. */
export const FINAL_CONSUMER_IDENTIFICATION = '9999999999999';
export const FINAL_CONSUMER_TYPE: BuyerIdentificationType = '07';
export const FINAL_CONSUMER_NAME = 'CONSUMIDOR FINAL';

/** The receiver block of the invoice, as the columns store it. */
export interface InvoiceReceiver {
  buyerIdentificationType: BuyerIdentificationType;
  buyerIdentification: string;
  buyerName: string;
  buyerEmail: string | null;
  isFinalConsumer: boolean;
}

/** What the cashier sends. Every field optional so the ABSENCE is a rejection. */
export interface ReceiverRequest {
  identificationType?: BuyerIdentificationType;
  identification?: string;
  name?: string;
  email?: string;
  /**
   * BI-081. The exception, and it only exists as a deliberate object.
   *
   * There is no boolean called `finalConsumer` that a client can set to `true`
   * and be done: the confirmation and the reason arrive together or the
   * request is refused. A flag would be one keystroke away from being the
   * default this requirement exists to prevent.
   */
  finalConsumer?: { confirmed?: boolean; reason?: string };
}

/** Who the account belongs to, for BI-082 and BI-087. */
export interface ReceiverContext {
  /** The identification of the patient of the account, when they have one. */
  patientIdentificationType: BuyerIdentificationType | null;
  patientIdentification: string | null;
  patientName: string;
  /** BI-087. The RUC of the payer, when the payer is NOT the patient. */
  thirdPartyPayerRuc: string | null;
}

/**
 * BI-082. What the screen OFFERS, which is the patient of the account.
 *
 * It is a proposal and never a default that is applied server-side: BI-080
 * still demands the receiver be stated, because the person who is going to
 * deduct the expense is not always the patient — a parent paying for a child,
 * a spouse — and BI-082 is exactly the requirement that it can be substituted.
 *
 * ⚠️ THE PAYER IS NOT A SOURCE HERE, AND THAT IS BI-035. The payer says WHICH
 * LIST THE PRICE COMES FROM. Who appears on the document is another question,
 * and confusing them is precisely how a reimbursement invoice comes out in the
 * insurer's name and the insurer rejects it (REQ-084, BI-087).
 */
export function proposeReceiver(context: ReceiverContext): ReceiverRequest {
  /**
   * BOTH HALVES OR NOTHING. A number with no type — a newborn's provisional
   * identifier, which the SRI recognises as nothing — would be proposed as a
   * cedula by any sensible-looking default, and the invoice would carry a
   * number no tax authority can match to a person. An empty proposal makes the
   * cashier state who is paying, which BI-080 demands anyway.
   */
  if (
    context.patientIdentification === null ||
    context.patientIdentificationType === null
  ) {
    return {};
  }

  return {
    identificationType: context.patientIdentificationType,
    identification: context.patientIdentification,
    name: context.patientName,
  };
}

/**
 * BI-080, BI-081, BI-087, BI-159. Turns what was sent into the receiver block, or
 * refuses.
 *
 * The order matters: the final-consumer branch is checked FIRST, because a
 * request that carries it is asking for the expensive exception and must not
 * be able to fall through into the ordinary path by omitting a field.
 */
export function resolveReceiver(
  request: ReceiverRequest,
  context: ReceiverContext,
): InvoiceReceiver {
  if (request.finalConsumer !== undefined) {
    return resolveFinalConsumer(request.finalConsumer);
  }

  const { identificationType, identification, name } = request;

  if (identificationType === undefined) {
    throw new InvoiceReceiverRequiredError('receiver.identificationType');
  }
  if (identification === undefined || identification.trim() === '') {
    throw new InvoiceReceiverRequiredError('receiver.identification');
  }
  if (name === undefined || name.trim() === '') {
    throw new InvoiceReceiverRequiredError('receiver.name');
  }

  /**
   * BI-081, the other half. `07` is «venta a consumidor final» in the SRI's
   * own table, so accepting it through the ordinary path would be the exact
   * bypass the explicit branch exists to close — and the database would take
   * the row happily, since `invoice_final_consumer_identification` only
   * constrains the FLAG.
   */
  if (identificationType === FINAL_CONSUMER_TYPE) {
    throw new FinalConsumerNotConfirmedError('receiver.identificationType');
  }

  checkIdentificationShape(identificationType, identification.trim());

  /**
   * BI-087. Not in the insurer's name, ever.
   *
   * The origin is the rejection insurers actually issue: a reimbursement
   * invoice made out to them is not the patient's expense and they send it
   * back. The check is on the RUC rather than on intent because that is the
   * form the mistake takes — somebody pastes the payer's RUC because it is the
   * one on the screen.
   */
  if (
    context.thirdPartyPayerRuc !== null &&
    identification.trim() === context.thirdPartyPayerRuc
  ) {
    throw new InvoiceReceiverIsPayerError();
  }

  return {
    buyerIdentificationType: identificationType,
    buyerIdentification: identification.trim(),
    buyerName: name.trim(),
    buyerEmail: request.email?.trim() ? request.email.trim() : null,
    isFinalConsumer: false,
  };
}

/** Where a receiver's identification error is shown (BI-080, BI-159). */
const RECEIVER_IDENTIFICATION_FIELD = 'receiver.identification';

/**
 * BI-159. The two identifications whose shape Ecuador defines — the RUC (`04`)
 * and the Ecuadorian cedula (`05`) — go through the value objects every other
 * register uses, and the error points at the receiver's field.
 *
 * The SRI checks both, but only AFTER the invoice is issued: by then it holds
 * its sequential and cannot be edited (BI-084), so a typo here costs a credit
 * note or a void. `06` (passport) and `08` (abroad) are issued by another
 * country and carry no shape this system can know.
 */
function checkIdentificationShape(
  type: BuyerIdentificationType,
  identification: string,
): void {
  try {
    if (type === '04') Ruc.create(identification);
    if (type === '05') Cedula.create(identification);
  } catch (error) {
    // Re-thrown with the field and the same reason; the number is never in it.
    if (error instanceof InvalidRucError) {
      throw new InvalidRucError(String(error.params.reason), RECEIVER_IDENTIFICATION_FIELD); // prettier-ignore
    }
    if (error instanceof InvalidCedulaError) {
      throw new InvalidCedulaError(String(error.params.reason), RECEIVER_IDENTIFICATION_FIELD); // prettier-ignore
    }
    throw error;
  }
}

/**
 * BI-081. The final-consumer receiver, only with `confirmed === true` AND a
 * non-blank reason; each missing half is refused naming its own field.
 *
 * The receiver block is fixed to the SRI placeholder and carries no email. The
 * reason is demanded here and is not part of the returned block.
 */
function resolveFinalConsumer(exception: {
  confirmed?: boolean;
  reason?: string;
}): InvoiceReceiver {
  if (exception.confirmed !== true) {
    throw new FinalConsumerNotConfirmedError(
      'receiver.finalConsumer.confirmed',
    );
  }
  if (exception.reason === undefined || exception.reason.trim() === '') {
    throw new FinalConsumerNotConfirmedError('receiver.finalConsumer.reason');
  }

  return {
    buyerIdentificationType: FINAL_CONSUMER_TYPE,
    buyerIdentification: FINAL_CONSUMER_IDENTIFICATION,
    buyerName: FINAL_CONSUMER_NAME,
    buyerEmail: null,
    isFinalConsumer: true,
  };
}

/** `invoice.sequential` is `varchar(9)`, and the SRI prints nine positions. */
const SEQUENTIAL_LENGTH = 9;

/**
 * BI-085. The next sequential of an emission point, with no gaps and no reuse.
 *
 * ⚠️ ZERO-PADDED TO NINE, AND THE PADDING IS SIGNIFICANT — the same rule
 * `emission_point.code` states for its three digits: «001» is not 1. Because
 * the width is fixed, the lexicographic maximum IS the numeric maximum, which
 * is what lets the adapter ask PostgreSQL for `max(sequential)` instead of
 * carrying a counter that could disagree with the rows.
 *
 * ⚠️ NOT EVEN A VOIDED INVOICE'S NUMBER COMES BACK. Reusing one is how the SRI
 * receives two different vouchers under the same access key — error 43 of
 * ADR-004, made permanent.
 *
 * The race between two cashiers is NOT arbitrated here: the adapter takes the
 * emission point's row lock before reading the maximum, and
 * `invoice_sequential_unique` is the last word. A pure function cannot close a
 * window between a read and a write, and pretending otherwise is how the gap
 * gets built.
 */
export function nextSequential(lastIssued: string | null): string {
  const previous = lastIssued === null ? 0 : Number.parseInt(lastIssued, 10);
  if (!Number.isInteger(previous) || previous < 0) {
    throw new RangeError(`Not a sequential: ${String(lastIssued)}`);
  }

  const next = previous + 1;
  const printed = String(next).padStart(SEQUENTIAL_LENGTH, '0');
  if (printed.length > SEQUENTIAL_LENGTH) {
    // 999 999 999 invoices from one emission point. Reaching it means the
    // clinic opens a new one; silently truncating would collide with the
    // number issued a billion documents ago.
    throw new RangeError('Emission point sequential is exhausted');
  }
  return printed;
}

/**
 * `invoice_status_is_known`. `DRAFT` exists in the column and this delivery
 * never writes it: an invoice is born ISSUED, because a draft that can be
 * edited is the «editar factura» D-A-007 forbids, arriving through the back
 * door. The SRI dialogue that produces AUTHORISED and REJECTED is Fase 2.
 */
export const INVOICE_STATUSES = [
  'DRAFT',
  'ISSUED',
  'AUTHORISED',
  'REJECTED',
  'VOIDED',
] as const;

/** One of `INVOICE_STATUSES`. */
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * BI-170. The SRI's table 24 of payment methods, as `invoice_payment_method_is_known`
 * admits them: 01 without the financial system, 15 debt compensation, 16 debit
 * card, 17 electronic money, 18 prepaid card, 19 credit card, 20 others through
 * the financial system, 21 endorsement of securities. Asked, never defaulted.
 */
export const PAYMENT_METHODS = [
  '01',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
  '21',
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
