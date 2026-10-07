import { describe, expect, it } from 'vitest';

import {
  addDays,
  clinicalDateOf,
  parseClinicalDate,
} from '../../../shared/domain/clinic-time';

import {
  CreditNoteLineAlreadyCreditedError,
  CreditNoteLineNotInInvoiceError,
  CreditNoteReasonRequiredError,
} from './billing.errors';
import {
  creditNoteDeadline,
  isWithinCreditNoteWindow,
  rebillsCreditedLines,
  resolveCreditNoteReason,
  selectCreditedCharges,
} from './credit-note';

describe('BI-209 el motivo que va en <motivo>', () => {
  it('BI-209 una entrada de la lista se escribe con su etiqueta, y el texto que llegue con ella no cuenta', () => {
    expect(resolveCreditNoteReason('RECEIVER_DATA', 'cualquier cosa')).toBe(
      'Error en los datos del receptor',
    );
    expect(resolveCreditNoteReason('AMOUNT', null)).toBe('Error en el importe');
    expect(resolveCreditNoteReason('SERVICE_NOT_PROVIDED', undefined)).toBe(
      'Servicio no prestado',
    );
  });

  it('BI-209 «Otro» lleva el texto escrito, en una línea, de 1 a 300 caracteres', () => {
    expect(resolveCreditNoteReason('OTHER', '  Cobro   duplicado\n')).toBe(
      'Cobro duplicado',
    );
    expect(resolveCreditNoteReason('OTHER', 'x'.repeat(300))).toHaveLength(300);
    expect(() => resolveCreditNoteReason('OTHER', '   ')).toThrow(
      CreditNoteReasonRequiredError,
    );
    expect(() => resolveCreditNoteReason('OTHER', null)).toThrow(
      CreditNoteReasonRequiredError,
    );
    expect(() => resolveCreditNoteReason('OTHER', 'x'.repeat(301))).toThrow(
      CreditNoteReasonRequiredError,
    );
  });
});

describe('BI-214 lo acreditado vuelve a facturarse', () => {
  it('BI-214 salvo cuando el servicio no se prestó', () => {
    expect(rebillsCreditedLines('RECEIVER_DATA')).toBe(true);
    expect(rebillsCreditedLines('AMOUNT')).toBe(true);
    expect(rebillsCreditedLines('OTHER')).toBe(true);
    expect(rebillsCreditedLines('SERVICE_NOT_PROVIDED')).toBe(false);
  });
});

describe('BI-094 doce meses desde la emisión, en Guayaquil', () => {
  // The clinic's today, from the clock; every date is derived from it.
  const today = clinicalDateOf(new Date());

  it('BI-094 el último día admitido es el mismo día doce meses después, y el siguiente ya no', () => {
    const issuedOn = addDays(today, -400);
    const deadline = creditNoteDeadline(issuedOn);

    expect(isWithinCreditNoteWindow(issuedOn, deadline)).toBe(true);
    expect(isWithinCreditNoteWindow(issuedOn, addDays(deadline, 1))).toBe(
      false,
    );
    expect(isWithinCreditNoteWindow(today, today)).toBe(true);
  });

  it('BI-094 una factura del 29 de febrero vence el 28 de febrero siguiente', () => {
    const leapDay = parseClinicalDate('2028-02-29'); // fecha-fija: borde del calendario, función pura
    const nextYear = parseClinicalDate('2029-02-28'); // fecha-fija: borde del calendario, función pura
    expect(creditNoteDeadline(leapDay)).toBe(nextYear);
  });
});

describe('BI-208 BI-211 qué líneas acredita', () => {
  const lines = ['a', 'b', 'c'];

  it('BI-208 sin elegir ninguna, todas las que aún no se acreditaron, en el orden de la factura', () => {
    expect(selectCreditedCharges(lines, new Set(), undefined)).toEqual(lines);
    expect(selectCreditedCharges(lines, new Set(['b']), [])).toEqual([
      'a',
      'c',
    ]);
  });

  it('BI-208 las elegidas, sin repetir y en el orden de la factura', () => {
    expect(selectCreditedCharges(lines, new Set(), ['c', 'a', 'c'])).toEqual([
      'a',
      'c',
    ]);
  });

  it('BI-211 rechaza una línea de otra factura y una ya acreditada', () => {
    expect(() => selectCreditedCharges(lines, new Set(), ['z'])).toThrow(
      CreditNoteLineNotInInvoiceError,
    );
    expect(() => selectCreditedCharges(lines, new Set(['a']), ['a'])).toThrow(
      CreditNoteLineAlreadyCreditedError,
    );
    expect(() =>
      selectCreditedCharges(lines, new Set(lines), undefined),
    ).toThrow(CreditNoteLineAlreadyCreditedError);
  });
});
