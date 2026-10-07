import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import { accessKeyParts, type SriEnvironment } from './access-key';

/**
 * The parts every SRI voucher shares —the invoice (SRI-010 to SRI-018) and the
 * credit note (SRI-085)—: the issuer, the frozen lines and their arithmetic,
 * `infoTributaria`, the escaping. Each document's composer adds what is its
 * own; nothing here knows which document it is part of except by `codDoc`.
 *
 * ⚠️ IT IS COMPOSED ONLY FROM FROZEN VALUES (SRI-011). Nothing here knows a
 * catalogue, a price list or a tax table exists.
 */

/** SRI table 16: the tax code of VAT. */
export const VAT_TAX_CODE = '2';

/** The SRI's two RIMPE legends (Ficha v2.34, Anexo 25). */
export const RIMPE_LEGEND = {
  NONE: null,
  ENTREPRENEUR: 'CONTRIBUYENTE RÉGIMEN RIMPE',
  POPULAR_BUSINESS: 'CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE',
} as const;

export type RimpeRegime = keyof typeof RIMPE_LEGEND;

/** Everything the voucher prints about whoever issues it (SRI-018). */
export interface VoucherIssuer {
  ruc: string;
  legalName: string;
  /** `dirMatriz`: the head office, mandatory (OR-028). */
  headOfficeAddress: string;
  /** `dirEstablecimiento`: the site's address, when it has one. */
  establishmentAddress: string | null;
  keepsAccounting: boolean;
  specialTaxpayerResolution: string | null;
  withholdingAgentResolution: string | null;
  rimpeRegime: RimpeRegime;
}

/** One frozen charge of the invoice. Amounts are decimal strings. */
export interface VoucherLine {
  code: string;
  description: string;
  /**
   * `charge_item.quantity` as a decimal string, up to three places: a
   * consumable is dispensed in fractions (0.5 of a vial).
   */
  quantity: string;
  unitPrice: string;
  discount: string;
  /** SRI table 17 `codigoPorcentaje`, frozen on the charge. */
  taxSriCode: string;
  /** The frozen rate, `15.00` for 15 %. */
  taxPercentage: string;
}

/** The invoice's stored totals, which the XML has to agree with (SRI-013). */
export interface VoucherTotals {
  subtotalTaxed: string;
  subtotalUntaxed: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
}

/** What every voucher states that its access key also states (SRI-019). */
export interface KeyedVoucher {
  environment: SriEnvironment;
  accessKey: string;
  issuer: VoucherIssuer;
  establishmentCode: string;
  emissionPointCode: string;
  sequential: string;
  issuedOn: ClinicalDate;
}

/**
 * SRI-013. The XML's own figures disagree with the invoice's stored ones.
 *
 * It would be the SRI's error 52 arriving AFTER the sequential was consumed;
 * composing refuses instead, and the voucher is never signed.
 */
export class VoucherTotalsMismatchError extends Error {
  constructor(readonly figure: keyof VoucherTotals) {
    super(`The voucher's ${figure} does not match the invoice's`);
    this.name = 'VoucherTotalsMismatchError';
  }
}

/**
 * SRI-019. A part of the content is not what the key says.
 *
 * The SRI returns such a voucher, and its key can never change (SRI-005):
 * composing refuses so the mismatch is a defect found here, not an invoice
 * rejected for ever.
 */
export class VoucherKeyMismatchError extends Error {
  constructor(
    readonly part:
      | 'ruc'
      | 'environment'
      | 'establishmentCode'
      | 'emissionPointCode'
      | 'sequential'
      | 'issuedOn',
  ) {
    super(`The voucher's ${part} is not the one in its access key`);
    this.name = 'VoucherKeyMismatchError';
  }
}

export function assertMatchesKey(source: KeyedVoucher): void {
  const key = accessKeyParts(source.accessKey);
  if (key.ruc !== source.issuer.ruc) throw new VoucherKeyMismatchError('ruc');
  if (key.environment !== source.environment) {
    throw new VoucherKeyMismatchError('environment');
  }
  if (key.establishmentCode !== source.establishmentCode) {
    throw new VoucherKeyMismatchError('establishmentCode');
  }
  if (key.emissionPointCode !== source.emissionPointCode) {
    throw new VoucherKeyMismatchError('emissionPointCode');
  }
  if (key.sequential !== source.sequential) {
    throw new VoucherKeyMismatchError('sequential');
  }
  if (key.issuedOn !== source.issuedOn) {
    throw new VoucherKeyMismatchError('issuedOn');
  }
}

// ── money in cents, so nothing here rounds through a float ─────────────────

export function toCents(amount: string): bigint {
  const match = /^(-?)([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(amount);
  if (!match) throw new Error('Amount is not a decimal with two places');
  const [, sign, units, fraction = ''] = match;
  const cents = BigInt(units!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -cents : cents;
}

/** Hundredths of a percent: `15.00` → 1500n. */
export function toHundredths(percentage: string): bigint {
  return toCents(percentage);
}

/** Half-up, on integers: the same rule `Money.percentageOf` applies (BI-058). */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

export function money(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const units = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}${units}.${fraction}`;
}

/** SRI-014. Six decimals for the unit price. */
export function sixDecimals(cents: bigint): string {
  return `${money(cents)}0000`;
}

/** A quantity in thousandths, as billing's `Quantity` holds it. */
export function toThousandths(quantity: string): bigint {
  const match = /^([0-9]+)(?:\.([0-9]{1,3}))?$/.exec(quantity);
  if (!match) throw new Error('Quantity is not a decimal with three places');
  const [, units, fraction = ''] = match;
  return BigInt(units!) * 1000n + BigInt(fraction.padEnd(3, '0'));
}

/** SRI-014. Six decimals for the quantity. */
export function quantityText(thousandths: bigint): string {
  const units = thousandths / 1000n;
  const fraction = String(thousandths % 1000n).padStart(3, '0');
  return `${units}.${fraction}000`;
}

// ── XML text ───────────────────────────────────────────────────────────────

/**
 * Characters XML 1.0 forbids even escaped —C0 controls other than tab and
 * line breaks, U+FFFE/U+FFFF and unpaired surrogates—. One pasted into a name
 * makes the signer fail, and an issued invoice cannot be corrected (BI-084):
 * they are dropped, as nothing a person reads is lost with them.
 */
const NOT_XML_CHARACTERS = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]' +
    '|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])' +
    '|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
  'g',
);

/**
 * SRI-014. The five reserved characters. The Ficha's glossary singles out the
 * ampersand —«caso contrario … se rechazará con motivo de mal estructurado»—,
 * and a clinic's legal name is exactly where one appears.
 */
export function escapeXml(text: string): string {
  return text
    .replace(NOT_XML_CHARACTERS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** One line of text per element, so the XSD's `[^\n]*` patterns hold. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function element(name: string, content: string): string {
  return `<${name}>${content}</${name}>`;
}

export function text(name: string, value: string): string {
  return element(name, escapeXml(singleLine(value)));
}

export function optional(name: string, value: string | null): string {
  return value === null || value.trim() === '' ? '' : text(name, value);
}

/** `2026-09-30` → `30/09/2026` (SRI-014). */
export function ddmmyyyy(date: ClinicalDate): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

/** The resolution number without leading zeros (Ficha, Anexo 25). */
export function withoutLeadingZeros(resolution: string): string {
  return resolution.replace(/^0+(?=[0-9])/, '');
}

// ── the composition ────────────────────────────────────────────────────────

export interface ComputedLine {
  line: VoucherLine;
  base: bigint;
  tax: bigint;
}

export function computeLine(line: VoucherLine): ComputedLine {
  // SRI-013. The line as billing computed it (`Money.times`): rounded half up
  // to the cent, so a fraction of a unit adds up to what the invoice stored.
  const gross = divideHalfUp(
    toCents(line.unitPrice) * toThousandths(line.quantity),
    1000n,
  );
  const base = gross - toCents(line.discount);
  const tax = divideHalfUp(base * toHundredths(line.taxPercentage), 10_000n);
  return { line, base, tax };
}

export function assertTotals(
  computed: readonly ComputedLine[],
  totals: VoucherTotals,
): void {
  const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);
  const base = sum(computed.map((c) => c.base));
  const tax = sum(computed.map((c) => c.tax));
  const discount = sum(computed.map((c) => toCents(c.line.discount)));

  // The invoice's subtotals are GROSS and the discount subtracts once
  // (`invoice_total_is_consistent`); the voucher's `totalSinImpuestos` is NET.
  const stored = {
    base:
      toCents(totals.subtotalTaxed) +
      toCents(totals.subtotalUntaxed) -
      toCents(totals.discountTotal),
    tax: toCents(totals.taxTotal),
    discount: toCents(totals.discountTotal),
    total: toCents(totals.total),
  };
  if (discount !== stored.discount) {
    throw new VoucherTotalsMismatchError('discountTotal');
  }
  if (base !== stored.base)
    throw new VoucherTotalsMismatchError('subtotalTaxed');
  if (tax !== stored.tax) throw new VoucherTotalsMismatchError('taxTotal');
  if (base + tax !== stored.total)
    throw new VoucherTotalsMismatchError('total');
}

/**
 * SRI-013. `totalConImpuestos`, grouped by `codigoPorcentaje`. The invoice's
 * XSD has a `tarifa` there; the credit note's does not (SRI-085).
 */
export function totalTaxes(
  computed: readonly ComputedLine[],
  options: { withRate: boolean },
): string {
  const groups = new Map<
    string,
    { base: bigint; tax: bigint; percentage: string }
  >();
  for (const { line, base, tax } of computed) {
    const group = groups.get(line.taxSriCode) ?? {
      base: 0n,
      tax: 0n,
      percentage: line.taxPercentage,
    };
    group.base += base;
    group.tax += tax;
    groups.set(line.taxSriCode, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, group]) =>
      element(
        'totalImpuesto',
        text('codigo', VAT_TAX_CODE) +
          text('codigoPorcentaje', code) +
          text('baseImponible', money(group.base)) +
          (options.withRate
            ? text('tarifa', money(toHundredths(group.percentage)))
            : '') +
          text('valor', money(group.tax)),
      ),
    )
    .join('');
}

/** SRI-013. A line's `impuestos`, the same in the invoice and the credit note. */
export function lineTaxes({ line, base, tax }: ComputedLine): string {
  return element(
    'impuestos',
    element(
      'impuesto',
      text('codigo', VAT_TAX_CODE) +
        text('codigoPorcentaje', line.taxSriCode) +
        text('tarifa', money(toHundredths(line.taxPercentage))) +
        text('baseImponible', money(base)) +
        text('valor', money(tax)),
    ),
  );
}

/**
 * `codigoPrincipal`: the XSD marks it optional, but the Ficha Técnica v2.34
 * makes it MANDATORY with at most 25 characters (the invoice's field table,
 * p. 50). Billing refuses to issue with a longer one (BI-171); one that slips
 * through is a defect, refused here rather than cut or left out.
 */
export const MAX_PRINCIPAL_CODE = 25;

export class VoucherLineCodeTooLongError extends Error {
  constructor(readonly code: string) {
    super('A line code exceeds the 25 characters of codigoPrincipal');
    this.name = 'VoucherLineCodeTooLongError';
  }
}

export function additionalField(name: string, value: string): string {
  return `<campoAdicional nombre="${escapeXml(name)}">${escapeXml(singleLine(value))}</campoAdicional>`;
}

/**
 * SRI-018. `infoTributaria`, the same block in every voucher but for its
 * `codDoc` (SRI table 3).
 */
export function infoTributaria(
  source: KeyedVoucher,
  codDoc: '01' | '04',
): string {
  const { issuer } = source;
  return element(
    'infoTributaria',
    text('ambiente', source.environment) +
      text('tipoEmision', '1') +
      text('razonSocial', issuer.legalName) +
      text('ruc', issuer.ruc) +
      text('claveAcceso', source.accessKey) +
      text('codDoc', codDoc) +
      text('estab', source.establishmentCode) +
      text('ptoEmi', source.emissionPointCode) +
      text('secuencial', source.sequential) +
      text('dirMatriz', issuer.headOfficeAddress) +
      optional(
        'agenteRetencion',
        issuer.withholdingAgentResolution === null
          ? null
          : withoutLeadingZeros(issuer.withholdingAgentResolution),
      ) +
      optional('contribuyenteRimpe', RIMPE_LEGEND[issuer.rimpeRegime]),
  );
}
