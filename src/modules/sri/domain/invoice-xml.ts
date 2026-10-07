import {
  additionalField,
  assertMatchesKey,
  assertTotals,
  computeLine,
  element,
  infoTributaria,
  lineTaxes,
  totalTaxes,
  MAX_PRINCIPAL_CODE,
  money,
  optional,
  quantityText,
  sixDecimals,
  text,
  toCents,
  toThousandths,
  ddmmyyyy,
  VoucherLineCodeTooLongError,
  type ComputedLine,
  type KeyedVoucher,
  type VoucherLine,
  type VoucherTotals,
} from './voucher-xml';

export {
  escapeXml,
  VoucherKeyMismatchError,
  VoucherLineCodeTooLongError,
  VoucherTotalsMismatchError,
  type RimpeRegime,
  type VoucherIssuer,
  type VoucherLine,
  type VoucherTotals,
} from './voucher-xml';

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

export interface InvoiceVoucherSource extends KeyedVoucher {
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

function detail({ line, base, tax }: ComputedLine): string {
  if (line.code.length > MAX_PRINCIPAL_CODE) {
    throw new VoucherLineCodeTooLongError(line.code);
  }
  return element(
    'detalle',
    text('codigoPrincipal', line.code) +
      text('descripcion', line.description) +
      text('cantidad', quantityText(toThousandths(line.quantity))) +
      text('precioUnitario', sixDecimals(toCents(line.unitPrice))) +
      text('descuento', money(toCents(line.discount))) +
      text('precioTotalSinImpuesto', money(base)) +
      lineTaxes({ line, base, tax }),
  );
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
  const totalBase = computed.reduce((sum, c) => sum + c.base, 0n);
  const total = toCents(source.totals.total);

  const tributaria = infoTributaria(source, '01');

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
      element('totalConImpuestos', totalTaxes(computed, { withRate: true })) +
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
    tributaria +
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
