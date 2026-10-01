import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import { DocumentRenderFailedError } from '../domain/document.errors';
import { PdfKitDocumentRenderer } from './pdfkit-document.renderer';
import type { LayoutImages } from '../domain/document-rendering.port';
import type { StoredImage } from '../domain/document-image';
import type { DocumentHeader, DocumentLayout } from '../domain/page-layout';

/**
 * DOC-020 to DOC-024. THE PDF IS INSPECTED, NEVER BELIEVED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS TEST IS THE ONE THAT JUSTIFIES THE WHOLE `embedded-fonts.ts` FILE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PDFKit's fourteen standard fonts are METRICS ONLY: there is no outline data
 * to embed, so a document that uses them comes out with `/BaseFont /Helvetica`
 * and no `FontFile2` anywhere. PDF/A requires every font to be embedded, so such
 * a file is NOT PDF/A — and PDFKit does not warn: it produces a perfectly
 * legible PDF that fails only in a validator, months later, during an audit.
 *
 * These assertions look for the byte sequences that prove otherwise. They are
 * NECESSARY AND NOT SUFFICIENT — full conformance needs veraPDF, which is Java
 * and is SC-062's open question — but they close the failure mode that actually
 * happens, which is somebody adding a `doc.font('Helvetica')` line.
 */

const images: LayoutImages = { logo: null, seal: null, signature: null };

const header: DocumentHeader = {
  establishmentName: 'Centro de Especialidades Bahía',
  establishmentRuc: null,
  establishmentAddress: null,
  establishmentPhone: null,
  hasLogo: false,
  fields: [{ label: 'Permiso ACESS', value: '0000-0000' }],
};

const layout: DocumentLayout = {
  frame: {
    title: 'RECETA MÉDICA',
    reference: 'RX-7Q2K',
    confidential: true,
    accentColour: '#1f6f8b',
    establishmentName: 'Centro de Especialidades Bahía',
    header,
    footer: {
      text: 'Clínica de especialidades · Guayaquil',
      verificationCode: 'RX-7Q2K',
    },
  },
  blocks: [
    { kind: 'heading', text: 'Paciente' },
    {
      kind: 'fields',
      columns: 2,
      entries: [
        { label: 'Apellidos y nombres', value: 'Guamán Andrade María José' },
        { label: 'Edad', value: '1 año 2 meses' },
      ],
    },
    { kind: 'rule' },
    {
      kind: 'table',
      columns: [
        { header: '#', width: 0.1, align: 'right' },
        { header: 'Medicamento (DCI)', width: 0.5 },
        { header: 'Cantidad', width: 0.4, align: 'right' },
      ],
      rows: [['1', 'Amoxicilina', '20 (veinte)']],
    },
    {
      kind: 'signature',
      caption: 'Firma y sello del profesional',
      image: null,
    },
    { kind: 'spacer', millimetres: 4 },
  ],
  tearOff: {
    caption: 'Indicaciones para el paciente — recorte por esta línea',
    identification: [
      { label: 'Paciente', value: 'Guamán Andrade María José' },
      { label: 'Fecha', value: '20/08/2026' },
    ],
    blocks: [{ kind: 'paragraph', text: 'Tomar con alimentos' }],
  },
};

const metadata = {
  title: 'RECETA MÉDICA',
  author: 'Centro de Especialidades Bahía',
  createdAt: new Date('2026-08-21T01:00:00Z'),
};

const renderer = new PdfKitDocumentRenderer();

describe('DOC-020 a DOC-024 el artefacto es PDF/A-1b de verdad', () => {
  it('DOC-020 produce un PDF 1.4, que es sobre el que se define PDF/A-1', async () => {
    const pdf = await renderer.render(layout, images, metadata);
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.4');
  });

  it('DOC-021 incrusta la fuente: el fichero lleva FontFile2 y NO nombra Helvetica', async () => {
    // THE ASSERTION THAT PAYS FOR `embedded-fonts.ts`. Without the registered
    // TTF this same document comes out with `/BaseFont /Helvetica` and no
    // `FontFile2` — legible, and not PDF/A.
    const pdf = await renderer.render(layout, images, metadata);
    const raw = pdf.toString('latin1');

    expect(raw).toContain('FontFile2');
    expect(raw).not.toContain('Helvetica');
    expect(raw).not.toContain('Times-Roman');
    expect(raw).not.toContain('Courier');
  });

  it('DOC-022 lleva el OutputIntent con el perfil sRGB y los metadatos pdfaid', async () => {
    const raw = (await renderer.render(layout, images, metadata)).toString(
      'latin1',
    );

    expect(raw).toContain('OutputIntent');
    expect(raw).toContain('GTS_PDFA1');
    expect(raw).toContain('sRGB IEC61966-2.1');
    expect(raw).toContain('pdfaid');
    expect(raw).toContain('<pdfaid:part>1</pdfaid:part>');
    expect(raw).toContain('<pdfaid:conformance>B</pdfaid:conformance>');
  });

  it('DOC-023 no cifra el documento', async () => {
    // PDF/A-1b forbids encryption outright.
    const raw = (await renderer.render(layout, images, metadata)).toString(
      'latin1',
    );
    expect(raw).not.toContain('/Encrypt');
  });

  it('DOC-024 fija la fecha de creación al instante de emisión, no al reloj', async () => {
    // Two identical documents produced from the same act have to be the same
    // file; a `new Date()` inside the renderer would make the `sha256`
    // meaningless.
    const raw = (await renderer.render(layout, images, metadata)).toString(
      'latin1',
    );
    // PDFKit writes `D:YYYYMMDDHHmmssZ` in UTC.
    expect(raw).toContain('D:20260821010000Z');
  });

  it('DOC-024 lleva el título y el establecimiento en sus metadatos', async () => {
    const raw = (await renderer.render(layout, images, metadata)).toString(
      'latin1',
    );
    expect(raw).toContain('/Title');
    expect(raw).toContain('/Author');
  });
});

describe('DOC-070, DOC-071, DOC-073 la geometría de la página', () => {
  it('DOC-070 compone en A4 vertical', async () => {
    const raw = (await renderer.render(layout, images, metadata)).toString(
      'latin1',
    );
    // 595.28 × 841.89 points is A4. PDFKit rounds to two decimals.
    expect(raw).toMatch(/MediaBox[^\]]*595\.28[^\]]*841\.89/);
  });

  it('DOC-071 numera todas las páginas, incluida la única', async () => {
    const pdf = await renderer.render(layout, images, metadata);
    // The text is subset-encoded, so the string is not searchable in the bytes.
    // What IS checkable is that exactly one page object exists and that the
    // second pass ran without leaving the document unflushed.
    const raw = pdf.toString('latin1');
    expect(raw).toContain('/Count 1');
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });

  it('DOC-073 dibuja la línea de corte de la banda desprendible', async () => {
    // The dashed cut line is a `d` (dash) operator followed by a stroke. Its
    // presence is what distinguishes a receta from the other three documents.
    const withBand = (await renderer.render(layout, images, metadata)).length;
    const withoutBand = (
      await renderer.render({ ...layout, tearOff: null }, images, metadata)
    ).length;

    expect(withBand).toBeGreaterThan(withoutBand);
  });

  it('DOC-071 pagina cuando el contenido no cabe, sin partir una línea', async () => {
    // Sixty prescription lines do not fit on one A4 with a 70 mm band reserved.
    const many: DocumentLayout = {
      ...layout,
      blocks: [
        {
          kind: 'table',
          columns: [
            { header: '#', width: 0.1, align: 'right' },
            { header: 'Medicamento (DCI)', width: 0.5 },
            { header: 'Cantidad', width: 0.4, align: 'right' },
          ],
          rows: Array.from({ length: 60 }, (_, index) => [
            String(index + 1),
            'Amoxicilina 500 mg tableta recubierta',
            '20 (veinte)',
          ]),
        },
      ],
    };

    const raw = (await renderer.render(many, images, metadata)).toString(
      'latin1',
    );
    expect(raw).not.toContain('/Count 1');
    expect(raw).toMatch(/\/Count [2-9]/);
  });
});

describe('DOC-059, DOC-060 las imágenes de la identidad', () => {
  /**
   * A real 8 × 8 opaque PNG, BUILT rather than pasted as base64.
   *
   * PDFKit decodes the file for real, so a hand-copied blob that is one byte
   * short fails inside the engine and the test would be measuring the fixture.
   * Building it with the same encoder the normaliser uses also keeps the shape
   * honest: OPAQUE, because PDF/A-1b forbids transparency (DOC-055).
   */
  let image: StoredImage;

  beforeAll(async () => {
    const bytes = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 20, g: 90, b: 140 },
      },
    })
      .png()
      .toBuffer();

    image = {
      id: 'image-1',
      mimeType: 'image/png',
      bytes,
      byteSize: bytes.byteLength,
      sha256: 'a'.repeat(64),
      width: 8,
      height: 8,
    };
  });

  it('DOC-059 emite sin logo y no se queja', async () => {
    // A clinic installed this morning has to be able to print a receta this
    // afternoon: the logo is not a mandatory field of any of the four
    // documents.
    await expect(
      renderer.render(layout, images, metadata),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it('DOC-059 pinta el logo cuando lo hay', async () => {
    const withLogo: DocumentLayout = {
      ...layout,
      frame: { ...layout.frame, header: { ...header, hasLogo: true } },
    };
    const pdf = await renderer.render(
      withLogo,
      { logo: image, seal: null, signature: null },
      metadata,
    );
    expect(pdf.toString('latin1')).toContain('/XObject');
  });

  it('DOC-060 pinta el sello guardado en lugar del recuadro vacío', async () => {
    const sealed: DocumentLayout = {
      ...layout,
      blocks: [
        {
          kind: 'signature',
          caption: 'Firma y sello del profesional',
          image: 'seal',
        },
      ],
    };
    const pdf = await renderer.render(
      sealed,
      { logo: null, seal: image, signature: null },
      metadata,
    );
    expect(pdf.toString('latin1')).toContain('/XObject');
  });
});

describe('DOC-093 el fallo de composición no cuenta nada al llamador', () => {
  it('DOC-093 traduce cualquier fallo del motor a DOCUMENT_RENDER_FAILED', async () => {
    // A stack trace from a PDF engine says nothing to a receptionist and can
    // carry a field value out with it.
    //
    // THE TRIGGER IS A CORRUPT IMAGE, which is the failure that can actually
    // reach this code: everything else the layout carries is a string this
    // module composed. The bytes stored are re-encoded (DOC-054), so a corrupt
    // one means the row was written around the application — and the answer is
    // still a sentence, not a decoder's stack.
    const withLogo: DocumentLayout = {
      ...layout,
      frame: { ...layout.frame, header: { ...header, hasLogo: true } },
    };
    const corrupt: StoredImage = {
      id: 'image-broken',
      mimeType: 'image/png',
      bytes: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
      ]),
      byteSize: 9,
      sha256: 'b'.repeat(64),
      width: 1,
      height: 1,
    };

    await expect(
      renderer.render(
        withLogo,
        { logo: corrupt, seal: null, signature: null },
        metadata,
      ),
    ).rejects.toThrow(DocumentRenderFailedError);
  });
});
