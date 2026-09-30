import { describe, expect, it } from 'vitest';

import {
  MAX_HEADER_FIELDS,
  assertSlotsAreValid,
  type TemplateSlots,
} from './document-template';
import { DocumentTemplateSlotInvalidError } from './document.errors';
import {
  CLINICAL_DOCUMENT_KINDS,
  DOCUMENT_KINDS,
  DOCUMENT_TITLE,
  isClinicalDocumentKind,
} from './document-kind';

const slots = (overrides: Partial<TemplateSlots> = {}): TemplateSlots => ({
  accentColour: '#1f6f8b',
  footerText: null,
  headerFields: [],
  showEstablishmentRuc: false,
  showEstablishmentAddress: false,
  showEstablishmentPhone: false,
  ...overrides,
});

describe('DOC-035 el color de acento', () => {
  it('DOC-035 acepta #rrggbb en minúsculas', () => {
    expect(() => assertSlotsAreValid(slots())).not.toThrow();
  });

  it('DOC-035 rechaza mayúsculas, nombres y formatos cortos', () => {
    // Case matters because the value is COMPARED, not only printed: `#AABBCC`
    // and `#aabbcc` would be two rows saying the same colour and neither could
    // be found by the other.
    for (const colour of ['#AABBCC', '#abc', 'azul', 'rgb(0,0,0)', '1f6f8b']) {
      expect(() =>
        assertSlotsAreValid(slots({ accentColour: colour })),
      ).toThrow(DocumentTemplateSlotInvalidError);
    }
  });

  it('DOC-035 nombra el campo, para que un formulario pueda señalarlo', () => {
    try {
      assertSlotsAreValid(slots({ accentColour: 'azul' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      const failure = error as DocumentTemplateSlotInvalidError;
      expect(failure.code).toBe('DOCUMENT_TEMPLATE_SLOT_INVALID');
      expect(failure.fieldErrors?.[0]?.field).toBe('accentColour');
    }
  });
});

describe('DOC-036 los campos clave-valor de la cabecera', () => {
  it('DOC-036 admite hasta seis', () => {
    const six = Array.from({ length: MAX_HEADER_FIELDS }, (_, index) => ({
      label: `Campo ${index}`,
      value: `Valor ${index}`,
    }));
    expect(() => assertSlotsAreValid(slots({ headerFields: six }))).not.toThrow(); // prettier-ignore
  });

  it('DOC-036 rechaza el séptimo', () => {
    // THE CAP IS THE SLOT MADE INTO A RULE. Without it, «unos pocos campos
    // clave-valor» becomes the free-form template this design refuses, one
    // field a week — and then no EARS requirement can describe the document.
    const seven = Array.from({ length: MAX_HEADER_FIELDS + 1 }, () => ({
      label: 'Campo',
      value: 'Valor',
    }));
    expect(() => assertSlotsAreValid(slots({ headerFields: seven }))).toThrow(
      DocumentTemplateSlotInvalidError,
    );
  });

  it('DOC-036 rechaza una etiqueta o un valor vacíos', () => {
    expect(() =>
      assertSlotsAreValid(
        slots({ headerFields: [{ label: '   ', value: 'Valor' }] }),
      ),
    ).toThrow(DocumentTemplateSlotInvalidError);

    expect(() =>
      assertSlotsAreValid(
        slots({ headerFields: [{ label: 'Campo', value: '' }] }),
      ),
    ).toThrow(DocumentTemplateSlotInvalidError);
  });

  it('DOC-036 rechaza un valor demasiado largo para caber en la cabecera', () => {
    expect(() =>
      assertSlotsAreValid(
        slots({ headerFields: [{ label: 'Campo', value: 'x'.repeat(200) }] }),
      ),
    ).toThrow(DocumentTemplateSlotInvalidError);
  });
});

describe('DOC-090 qué clases sirve cada permiso', () => {
  it('DOC-090 el RIDE no es contenido clínico', () => {
    // The separation that matters: a tax document is not a chart, and whoever
    // may open a chart has no business being handed an invoice because both
    // happen to be PDFs.
    expect(isClinicalDocumentKind('INVOICE_RIDE')).toBe(false);
    for (const kind of CLINICAL_DOCUMENT_KINDS) {
      expect(isClinicalDocumentKind(kind)).toBe(true);
    }
  });

  it('DOC-079 no existe la clase «receta de controlados»', () => {
    // It is pre-printed paper the ACESS issues and sells, with its own
    // numbering and under the doctor's nominal custody. A PDF we produced would
    // not be that prescription.
    expect(DOCUMENT_KINDS).toHaveLength(4);
    expect(DOCUMENT_KINDS.join(',')).not.toMatch(/CONTROLLED|ESTUPEFACIENTE/i);
  });

  it('DOC-070 cada clase tiene su título en español', () => {
    for (const kind of DOCUMENT_KINDS) {
      expect(DOCUMENT_TITLE[kind].length).toBeGreaterThan(0);
    }
  });
});
