import type { ClinicalDate } from '../../../shared/domain/clinic-time';

import {
  additionalField,
  assertMatchesKey,
  assertTotals,
  computeLine,
  ddmmyyyy,
  element,
  infoTributaria,
  lineTaxes,
  MAX_PRINCIPAL_CODE,
  money,
  optional,
  quantityText,
  sixDecimals,
  text,
  toCents,
  toThousandths,
  totalTaxes,
  VoucherLineCodeTooLongError,
  type ComputedLine,
  type KeyedVoucher,
  type VoucherLine,
  type VoucherTotals,
} from './voucher-xml';

/**
 * SRI-085. The XML of a credit note, version 1.1.0 of the SRI's schema
 * (`NotaCredito_V1.1.0.xsd`, February 2022, versioned in
 * `infrastructure/xsd/`), with the Ficha Técnica v2.34 field table of the
 * credit note (pp. 55-57 and 71).
 *
 * What differs from the invoice, and is the reason this is its own composer:
 *
 * - `infoNotaCredito` instead of `infoFactura`: it names the document it
 *   modifies (`codDocModificado` `01`, `numDocModificado` `001-001-000000001`,
 *   `fechaEmisionDocSustento`), totals as `valorModificacion`, and carries the
 *   mandatory `motivo` (1 to 300 characters in the XSD; BI-209).
 * - No `pagos`, `propina` or `totalDescuento`.
 * - `totalImpuesto` without `tarifa`, and each line's code is
 *   `codigoInterno`.
 *
 * ⚠️ THE VAT RATE IS THE ONE OF THE DOCUMENT IT MODIFIES (the Ficha's note on
 * the format). That is what billing froze on each credited charge and copied
 * to the credit note's line (BI-210): nothing here knows a tax table exists.
 */
export const CREDIT_NOTE_SCHEMA_VERSION = '1.1.0';

export interface CreditNoteVoucherSource extends KeyedVoucher {
  /** The receiver of the invoice it modifies (D-152.2). */
  buyer: {
    identificationType: string;
    identification: string;
    name: string;
    email: string | null;
  };
  /** The invoice: `estab-ptoEmi-secuencial` and its date of issue. */
  modifiedDocument: { number: string; issuedOn: ClinicalDate };
  /** `motivo`: the list's label, or what was written for «Otro». */
  reason: string;
  lines: readonly VoucherLine[];
  /** The credit note's stored totals; `total` is `valorModificacion`. */
  totals: VoucherTotals;
  /** Anexo 26. `null` when the installation has not declared it (D-091). */
  softwareProviderRuc: string | null;
}

/** `001-001-000000123`: the XSD's `numDocModificado` pattern. */
export function documentNumber(parts: {
  establishmentCode: string;
  emissionPointCode: string;
  sequential: string;
}): string {
  return `${parts.establishmentCode}-${parts.emissionPointCode}-${parts.sequential}`;
}

function detail(computed: ComputedLine): string {
  const { line, base } = computed;
  if (line.code.length > MAX_PRINCIPAL_CODE) {
    throw new VoucherLineCodeTooLongError(line.code);
  }
  return element(
    'detalle',
    text('codigoInterno', line.code) +
      text('descripcion', line.description) +
      text('cantidad', quantityText(toThousandths(line.quantity))) +
      text('precioUnitario', sixDecimals(toCents(line.unitPrice))) +
      text('descuento', money(toCents(line.discount))) +
      text('precioTotalSinImpuesto', money(base)) +
      lineTaxes(computed),
  );
}

/**
 * SRI-085. The unsigned XML of a credit note. Like the invoice's, it refuses
 * to produce a document whose figures disagree with what was stored
 * (`VoucherTotalsMismatchError`) or with its own key (`VoucherKeyMismatchError`).
 */
export function composeCreditNoteXml(source: CreditNoteVoucherSource): string {
  assertMatchesKey(source);
  const computed = source.lines.map(computeLine);
  assertTotals(computed, source.totals);

  const { issuer } = source;
  const totalBase = computed.reduce((sum, c) => sum + c.base, 0n);

  const infoNotaCredito = element(
    'infoNotaCredito',
    text('fechaEmision', ddmmyyyy(source.issuedOn)) +
      optional('dirEstablecimiento', issuer.establishmentAddress) +
      text('tipoIdentificacionComprador', source.buyer.identificationType) +
      text('razonSocialComprador', source.buyer.name) +
      text('identificacionComprador', source.buyer.identification) +
      optional('contribuyenteEspecial', issuer.specialTaxpayerResolution) +
      text('obligadoContabilidad', issuer.keepsAccounting ? 'SI' : 'NO') +
      text('codDocModificado', '01') +
      text('numDocModificado', source.modifiedDocument.number) +
      text(
        'fechaEmisionDocSustento',
        ddmmyyyy(source.modifiedDocument.issuedOn),
      ) +
      text('totalSinImpuestos', money(totalBase)) +
      text('valorModificacion', money(toCents(source.totals.total))) +
      text('moneda', 'DOLAR') +
      element('totalConImpuestos', totalTaxes(computed, { withRate: false })) +
      text('motivo', source.reason),
  );

  const additional = [
    source.buyer.email === null || source.buyer.email.trim() === ''
      ? ''
      : additionalField('Email', source.buyer.email),
    source.softwareProviderRuc === null
      ? ''
      : additionalField('RUC Proveedor', source.softwareProviderRuc),
  ].join('');

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<notaCredito id="comprobante" version="${CREDIT_NOTE_SCHEMA_VERSION}">` +
    infoTributaria(source, '04') +
    infoNotaCredito +
    element('detalles', computed.map(detail).join('')) +
    (additional === '' ? '' : element('infoAdicional', additional)) +
    '</notaCredito>'
  );
}
