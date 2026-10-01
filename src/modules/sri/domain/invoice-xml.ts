import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import { accessKeyParts, type SriEnvironment } from './access-key';

/**
 * SRI-010 to SRI-018. The XML of an invoice, version 1.1.0 of the SRI's schema.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SCHEMA VERSION LIVES HERE AND NOWHERE ELSE (REQ-080, SRI-010)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Ficha changes once or twice a year. The XSD this composer is tested
 * against is versioned beside the adapter (`infrastructure/xsd/`), and the
 * version each voucher was composed with is stored on the voucher.
 *
 * ⚠️ WHERE THE FICHA AND THE XSD DISAGREE, THE FICHA WINS. The official XSD
 * 1.1.0 (February 2022) declares `pagos` and `propina` optional; the Ficha
 * v2.34 marks both «Obligatorio». And the XSD's `contribuyenteRimpe` pattern
 * only knows the entrepreneur's legend, while the Ficha (Anexo 25) adds the
 * popular-business one.
 *
 * ⚠️ IT IS COMPOSED ONLY FROM FROZEN VALUES (SRI-011). Nothing here knows a
 * catalogue, a price list or a tax table exists: the lines are the invoice's
 * own charges with what was frozen on them (BI-086, BI-169).
 */
export const INVOICE_SCHEMA_VERSION = '1.1.0';

/** SRI table 16: the tax code of VAT. */
const VAT_TAX_CODE = '2';

/** The SRI's two RIMPE legends (Ficha v2.34, Anexo 25). */
const RIMPE_LEGEND = {
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

export interface InvoiceVoucherSource {
  environment: SriEnvironment;
  accessKey: string;
  issuer: VoucherIssuer;
  establishmentCode: string;
  emissionPointCode: string;
  sequential: string;
  issuedOn: ClinicalDate;
  buyer: {
    identificationType: string;
    identification: string;
    name: string;
    email: string | null;
  };
  lines: readonly VoucherLine[];
  totals: VoucherTotals;
  /** SRI table 24. `null` when the installation has not declared it (D-092). */
  paymentMethod: string | null;
  /** Anexo 26. `null` when the installation has not declared it (D-091). */
  softwareProviderRuc: string | null;
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

function assertMatchesKey(source: InvoiceVoucherSource): void {
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

function toCents(amount: string): bigint {
  const match = /^(-?)([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(amount);
  if (!match) throw new Error('Amount is not a decimal with two places');
  const [, sign, units, fraction = ''] = match;
  const cents = BigInt(units!) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign === '-' ? -cents : cents;
}

/** Hundredths of a percent: `15.00` → 1500n. */
function toHundredths(percentage: string): bigint {
  return toCents(percentage);
}

/** Half-up, on integers: the same rule `Money.percentageOf` applies (BI-058). */
function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function money(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const units = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}${units}.${fraction}`;
}

/** SRI-014. Six decimals for the unit price. */
function sixDecimals(cents: bigint): string {
  return `${money(cents)}0000`;
}

/** A quantity in thousandths, as billing's `Quantity` holds it. */
function toThousandths(quantity: string): bigint {
  const match = /^([0-9]+)(?:\.([0-9]{1,3}))?$/.exec(quantity);
  if (!match) throw new Error('Quantity is not a decimal with three places');
  const [, units, fraction = ''] = match;
  return BigInt(units!) * 1000n + BigInt(fraction.padEnd(3, '0'));
}

/** SRI-014. Six decimals for the quantity. */
function quantityText(thousandths: bigint): string {
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
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function element(name: string, content: string): string {
  return `<${name}>${content}</${name}>`;
}

function text(name: string, value: string): string {
  return element(name, escapeXml(singleLine(value)));
}

function optional(name: string, value: string | null): string {
  return value === null || value.trim() === '' ? '' : text(name, value);
}

/** `2026-09-30` → `30/09/2026` (SRI-014). */
function ddmmyyyy(date: ClinicalDate): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

/** The resolution number without leading zeros (Ficha, Anexo 25). */
function withoutLeadingZeros(resolution: string): string {
  return resolution.replace(/^0+(?=[0-9])/, '');
}

// ── the composition ────────────────────────────────────────────────────────

interface ComputedLine {
  line: VoucherLine;
  base: bigint;
  tax: bigint;
}

function computeLine(line: VoucherLine): ComputedLine {
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

function assertTotals(
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

/** SRI-013. `totalConImpuestos`, grouped by `codigoPorcentaje`. */
function totalTaxes(computed: readonly ComputedLine[]): string {
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
          text('tarifa', money(toHundredths(group.percentage))) +
          text('valor', money(group.tax)),
      ),
    )
    .join('');
}

/** The XSD's `codigoPrincipal`: at most 25 characters, and optional. */
const MAX_PRINCIPAL_CODE = 25;

function detail({ line, base, tax }: ComputedLine): string {
  return element(
    'detalle',
    // A catalogue code longer than the XSD admits is left out rather than
    // cut: a truncated code could be another service's. The line is still
    // identified by its description, which is mandatory.
    optional(
      'codigoPrincipal',
      line.code.length <= MAX_PRINCIPAL_CODE ? line.code : null,
    ) +
      text('descripcion', line.description) +
      text('cantidad', quantityText(toThousandths(line.quantity))) +
      text('precioUnitario', sixDecimals(toCents(line.unitPrice))) +
      text('descuento', money(toCents(line.discount))) +
      text('precioTotalSinImpuesto', money(base)) +
      element(
        'impuestos',
        element(
          'impuesto',
          text('codigo', VAT_TAX_CODE) +
            text('codigoPorcentaje', line.taxSriCode) +
            text('tarifa', money(toHundredths(line.taxPercentage))) +
            text('baseImponible', money(base)) +
            text('valor', money(tax)),
        ),
      ),
  );
}

function additionalField(name: string, value: string): string {
  return `<campoAdicional nombre="${escapeXml(name)}">${escapeXml(singleLine(value))}</campoAdicional>`;
}

/**
 * SRI-010 to SRI-018. The unsigned XML. Throws `VoucherTotalsMismatchError`
 * before producing a document whose figures the SRI would reject.
 *
 * Without a declared payment method `pagos` is left out — the XSD admits it
 * and the key still exists for the RIDE — and SRI-017 is enforced by the
 * preparation, which refuses to SIGN such a voucher.
 */
export function composeInvoiceXml(source: InvoiceVoucherSource): string {
  assertMatchesKey(source);
  const computed = source.lines.map(computeLine);
  assertTotals(computed, source.totals);

  const { issuer } = source;
  const rimpe = RIMPE_LEGEND[issuer.rimpeRegime];
  const totalBase = computed.reduce((sum, c) => sum + c.base, 0n);
  const total = toCents(source.totals.total);

  const infoTributaria = element(
    'infoTributaria',
    text('ambiente', source.environment) +
      text('tipoEmision', '1') +
      text('razonSocial', issuer.legalName) +
      text('ruc', issuer.ruc) +
      text('claveAcceso', source.accessKey) +
      text('codDoc', '01') +
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
      optional('contribuyenteRimpe', rimpe),
  );

  const infoFactura = element(
    'infoFactura',
    text('fechaEmision', ddmmyyyy(source.issuedOn)) +
      optional('dirEstablecimiento', issuer.establishmentAddress) +
      optional('contribuyenteEspecial', issuer.specialTaxpayerResolution) +
      text('obligadoContabilidad', issuer.keepsAccounting ? 'SI' : 'NO') +
      text('tipoIdentificacionComprador', source.buyer.identificationType) +
      text('razonSocialComprador', source.buyer.name) +
      text('identificacionComprador', source.buyer.identification) +
      text('totalSinImpuestos', money(totalBase)) +
      text('totalDescuento', money(toCents(source.totals.discountTotal))) +
      element('totalConImpuestos', totalTaxes(computed)) +
      text('propina', '0.00') +
      text('importeTotal', money(total)) +
      text('moneda', 'DOLAR') +
      (source.paymentMethod === null
        ? ''
        : element(
            'pagos',
            element(
              'pago',
              text('formaPago', source.paymentMethod) +
                text('total', money(total)),
            ),
          )),
  );

  const additional = [
    source.buyer.email === null || source.buyer.email.trim() === ''
      ? ''
      : additionalField('Email', source.buyer.email),
    // Anexo 26: the attribute is literally «RUC Proveedor», with a space.
    source.softwareProviderRuc === null
      ? ''
      : additionalField('RUC Proveedor', source.softwareProviderRuc),
  ].join('');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<factura id="comprobante" version="${INVOICE_SCHEMA_VERSION}">` +
    infoTributaria +
    infoFactura +
    element('detalles', computed.map(detail).join('')) +
    (additional === '' ? '' : element('infoAdicional', additional)) +
    '</factura>'
  );
}

/**
 * SRI-015. The root must carry `id="comprobante"` before signing: the library
 * signs without it and emits a reference to an id that does not exist, and the
 * SRI answers 39 without saying why (ADR-004 §2).
 */
export function hasVoucherRootId(xml: string): boolean {
  return /<(factura|notaCredito|notaDebito|guiaRemision|comprobanteRetencion)\s[^>]*\bid="comprobante"/.test(
    xml,
  );
}
