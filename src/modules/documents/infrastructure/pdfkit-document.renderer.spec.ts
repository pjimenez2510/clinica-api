import { inflateSync } from 'node:zlib';

import sharp from 'sharp';
import { extractText, getDocumentProxy } from 'unpdf';
import { beforeAll, describe, expect, it } from 'vitest';

import { DocumentRenderFailedError } from '../domain/document.errors';
import { TEAR_OFF_HEIGHT_MM, millimetresToPoints } from '../domain/page-layout';
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
  siteLine: null,
  establishmentRuc: null,
  establishmentAddress: null,
  establishmentPhone: null,
  establishmentEmail: null,
  operatingPermit: null,
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
    hasLogo: false,
    footer: {
      text: 'Clínica de especialidades · Guayaquil',
      verification: {
        code: 'RX-7Q2K',
        url: 'https://clinica.example/verificar/RX-7Q2K',
      },
      notes: ['Copia de respaldo conservada cinco años'],
    },
    watermark: null,
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

  it('DOC-025 incrusta Source Sans 3 y Source Serif 4, y ninguna otra fuente', async () => {
    // D-095.2. The subset prefix varies (`ABCDEF+`); the family name does not.
    const raw = (await renderer.render(layout, images, metadata)).toString(
      'latin1',
    );
    const families = new Set(
      [...raw.matchAll(/\/BaseFont \/(?:[A-Z]{6}\+)?([A-Za-z0-9-]+)/g)].map(
        (match) => match[1],
      ),
    );

    expect(families).toContain('SourceSans3-Regular');
    expect(families).toContain('SourceSerif4-Bold');
    expect(
      [...families].every(
        (family) =>
          family?.startsWith('SourceSans3-') ||
          family?.startsWith('SourceSerif4-'),
      ),
    ).toBe(true);
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

describe('DOC-076 las cajas no se parten ni pisan el pie', () => {
  const boxes = {
    kind: 'boxes' as const,
    left: [{ kind: 'paragraph' as const, text: 'Información adicional' }],
    right: [
      {
        kind: 'table' as const,
        columns: [
          { header: 'Subtotales', width: 0.7 },
          { header: 'Valor', width: 0.3, align: 'right' as const },
        ],
        rows: Array.from({ length: 10 }, (_, index) => [
          index === 9 ? 'VALOR TOTAL' : `SUBTOTAL ${index}`,
          '0.00',
        ]),
      },
    ],
  };
  const lines = (count: number) => ({
    kind: 'table' as const,
    columns: [{ header: 'Descripción', width: 1 }],
    rows: Array.from({ length: count }, (_, index) => [`Línea ${index + 1}`]),
  });
  const pagesOf = async (pdf: Buffer): Promise<string[]> => {
    const proxy = await getDocumentProxy(new Uint8Array(pdf));
    return (await extractText(proxy, { mergePages: false })).text;
  };

  it('DOC-076 una pareja de cajas que no cabe en lo que queda pasa entera a la página siguiente', async () => {
    const base: DocumentLayout = { ...layout, tearOff: null };
    // The longest detail that still fits on ONE page by itself: right after
    // it there is no room for the totals.
    let fitting = 0;
    for (let count = 10; count <= 80; count += 1) {
      const alone = await renderer.render(
        { ...base, blocks: [lines(count)] },
        images,
        metadata,
      );
      if ((await pagesOf(alone)).length > 1) break;
      fitting = count;
    }

    const pages = await pagesOf(
      await renderer.render(
        { ...base, blocks: [lines(fitting), boxes] },
        images,
        metadata,
      ),
    );
    expect(pages).toHaveLength(2);
    expect(pages[0]).toContain(`Línea ${fitting}`);
    expect(pages[0]).not.toContain('VALOR TOTAL');
    expect(pages[1]).toContain('VALOR TOTAL');
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
      frame: {
        ...layout.frame,
        hasLogo: true,
        header: { ...header, hasLogo: true },
      },
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
      frame: {
        ...layout.frame,
        hasLogo: true,
        header: { ...header, hasLogo: true },
      },
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

/** The text a person reads on the page, extracted by a PDF reader. */
async function textOf(pdf: Buffer): Promise<string> {
  const proxy = await getDocumentProxy(new Uint8Array(pdf));
  const { text } = await extractText(proxy, { mergePages: true });
  return text;
}

/** How many rectangles the page streams draw: a QR is hundreds of them. */
function rectanglesIn(pdf: Buffer): number {
  const raw = pdf.toString('latin1');
  let count = 0;
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    const body = Buffer.from(match[1] ?? '', 'latin1');
    let content: string;
    try {
      content = inflateSync(body).toString('latin1');
    } catch {
      continue;
    }
    count += (content.match(/ re\b/g) ?? []).length;
  }
  return count;
}

describe('DOC-080 a DOC-084 el marco aprobado, pintado', () => {
  it('DOC-080 la cabecera lleva nombre, título, referencia, correo y permiso', async () => {
    const text = await textOf(
      await renderer.render(
        {
          ...layout,
          frame: {
            ...layout.frame,
            reference: 'Receta N.º 128',
            header: {
              ...header,
              establishmentEmail: 'contacto@example.com',
              operatingPermit: 'ACESS-2026-0456',
            },
          },
        },
        images,
        metadata,
      ),
    );

    expect(text).toContain('Centro de Especialidades Bahía');
    expect(text).toContain('RECETA MÉDICA');
    expect(text).toContain('Receta N.º 128');
    expect(text).toContain('contacto@example.com');
    expect(text).toContain('ACESS-2026-0456');
  });

  it('DOC-081 pinta la línea de sede sólo cuando el marco la trae', async () => {
    const without = await textOf(
      await renderer.render(layout, images, metadata),
    );
    const withSite = await textOf(
      await renderer.render(
        {
          ...layout,
          frame: {
            ...layout.frame,
            header: { ...header, siteLine: 'Sede Norte · Unicódigo 012345' },
          },
        },
        images,
        metadata,
      ),
    );

    expect(without).not.toContain('Unicódigo');
    expect(withSite).toContain('Sede Norte · Unicódigo 012345');
  });

  it('DOC-082 rotula CONFIDENCIAL sólo cuando el documento lleva diagnóstico', async () => {
    const confidential = await textOf(
      await renderer.render(layout, images, metadata),
    );
    const plain = await textOf(
      await renderer.render(
        { ...layout, frame: { ...layout.frame, confidential: false } },
        images,
        metadata,
      ),
    );

    expect(confidential).toContain('CONFIDENCIAL');
    expect(plain).not.toContain('CONFIDENCIAL');
  });

  it('DOC-071 DOC-083 el pie lleva página x de y, el código, la dirección y la nota', async () => {
    const text = await textOf(await renderer.render(layout, images, metadata));

    expect(text).toContain('Página 1 de 1');
    expect(text).toContain('RX-7Q2K');
    expect(text).toContain('https://clinica.example/verificar/RX-7Q2K');
    expect(text).toContain('Copia de respaldo conservada cinco años');
  });

  it('DOC-071 numera cada página sobre el total cuando el documento ocupa varias', async () => {
    const long: DocumentLayout = {
      ...layout,
      blocks: Array.from({ length: 80 }, (_, index) => ({
        kind: 'paragraph' as const,
        text: `Párrafo ${index + 1} de un documento largo`,
      })),
    };
    const text = await textOf(await renderer.render(long, images, metadata));

    expect(text).toContain('Página 1 de');
    expect(text).toMatch(/Página (\d+) de \1/);
  });

  it('DOC-083 dibuja el QR como trazos, y no lo dibuja sin verificación', async () => {
    const withQr = rectanglesIn(
      await renderer.render(layout, images, metadata),
    );
    const withoutQr = rectanglesIn(
      await renderer.render(
        {
          ...layout,
          frame: {
            ...layout.frame,
            footer: { ...layout.frame.footer, verification: null },
          },
        },
        images,
        metadata,
      ),
    );

    // A version-2 QR has 25×25 modules and roughly half of them are dark.
    expect(withQr - withoutQr).toBeGreaterThan(150);
  });

  it('DOC-084 sin cabecera común no pinta ni título ni CONFIDENCIAL: el RIDE trae los suyos', async () => {
    const text = await textOf(
      await renderer.render(
        {
          ...layout,
          tearOff: null,
          frame: {
            ...layout.frame,
            title: 'FACTURA',
            confidential: false,
            header: null,
            footer: {
              text: null,
              verification: null,
              notes: [
                'Representación impresa del comprobante electrónico (RIDE)',
              ],
            },
          },
        },
        images,
        metadata,
      ),
    );

    expect(text).not.toContain('Centro de Especialidades Bahía');
    expect(text).toContain(
      'Representación impresa del comprobante electrónico',
    );
    expect(text).toContain('Página 1 de 1');
  });
});

describe('DOC-083 el pie nunca abre páginas', () => {
  it('DOC-034 DOC-083 el pie de la clínica sale también en la receta, con verificación y nota', async () => {
    const text = await textOf(
      await renderer.render(recetaWith(1), images, metadata),
    );
    expect(text).toContain('Verifique en');
    expect(text).toContain('Copia de respaldo conservada cinco años');
    expect(text).toContain('Clínica de especialidades · Guayaquil');
  });

  it('DOC-071 DOC-083 un pie de seis líneas no añade páginas ni miente sobre el total', async () => {
    const longFooter = Array.from(
      { length: 6 },
      (_, index) =>
        `Línea ${index + 1} del pie que la clínica escribió en la plantilla`,
    ).join('\n');
    const pdf = await renderer.render(
      {
        ...layout,
        frame: {
          ...layout.frame,
          footer: { ...layout.frame.footer, text: longFooter },
        },
      },
      images,
      metadata,
    );

    expect(pdf.toString('latin1')).toContain('/Count 1');
    expect(await textOf(pdf)).toContain('Página 1 de 1');
  });
});

describe('DOC-038 la muestra lo dice en cada página', () => {
  it('DOC-038 pinta MUESTRA SIN VALIDEZ cuando el marco la trae, y nada cuando no', async () => {
    const sample = await textOf(
      await renderer.render(
        {
          ...layout,
          frame: { ...layout.frame, watermark: 'MUESTRA SIN VALIDEZ' },
        },
        images,
        metadata,
      ),
    );
    const issued = await textOf(
      await renderer.render(layout, images, metadata),
    );

    expect(sample).toContain('MUESTRA SIN VALIDEZ');
    expect(issued).not.toContain('MUESTRA SIN VALIDEZ');
  });
});

/** Where a text sits on page `n`, in points from the BOTTOM edge (PDF space). */
async function heightOf(pdf: Buffer, needle: string, n = 1): Promise<number> {
  const proxy = await getDocumentProxy(new Uint8Array(pdf));
  const page = await proxy.getPage(n);
  const content = await page.getTextContent();
  const item = content.items.find(
    (entry) => 'str' in entry && entry.str.includes(needle),
  );
  if (!item || !('transform' in item)) throw new Error(`no «${needle}»`);
  return (item.transform as number[])[5] ?? 0;
}

const longIndication =
  'Tome una tableta cada ocho horas con alimentos; no conduzca ni opere maquinaria; suspenda si aparece sarpullido y consulte.';

function recetaWith(lines: number): DocumentLayout {
  return {
    ...layout,
    tearOff: {
      caption: 'Indicaciones para el paciente — recorte por esta línea',
      identification: [
        { label: 'Paciente', value: 'Guamán Andrade María José' },
        { label: 'Fecha', value: '20/08/2026' },
      ],
      blocks: [
        {
          kind: 'fields',
          columns: 1,
          entries: Array.from({ length: lines }, (_, index) => ({
            label: `Línea ${index + 1}`,
            value: longIndication,
          })),
        },
        { kind: 'signature', caption: 'Sello del profesional', image: null },
      ],
    },
  };
}

describe('DOC-073 DOC-083 la banda desprendible y el pie de la receta', () => {
  it('DOC-083 el pie de la receta queda por ENCIMA de la línea de corte: la farmacia conserva QR y página', async () => {
    const pdf = await renderer.render(recetaWith(1), images, metadata);
    const cut = millimetresToPoints(TEAR_OFF_HEIGHT_MM);

    expect(await heightOf(pdf, 'Página 1 de 1')).toBeGreaterThan(cut);
    expect(await heightOf(pdf, 'Verifique en')).toBeGreaterThan(cut);
    expect(await heightOf(pdf, 'Indicaciones para el paciente')).toBeLessThan(
      cut,
    );
  });

  it('DOC-073 dos indicaciones largas caben en la banda de una sola página', async () => {
    const pdf = await renderer.render(recetaWith(2), images, metadata);
    const proxy = await getDocumentProxy(new Uint8Array(pdf));
    expect(proxy.numPages).toBe(1);
  });

  it('DOC-071 DOC-073 si las indicaciones no caben, siguen en otra página con cabecera y con el nombre del paciente', async () => {
    const pdf = await renderer.render(recetaWith(12), images, metadata);
    const proxy = await getDocumentProxy(new Uint8Array(pdf));
    expect(proxy.numPages).toBeGreaterThan(1);

    for (let n = 2; n <= proxy.numPages; n += 1) {
      const page = await proxy.getPage(n);
      const text = (await page.getTextContent()).items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ');
      expect(text).toContain('Centro de Especialidades Bahía');
      expect(text).toContain('continuación');
      expect(text).toContain('Guamán Andrade María José');
      expect(text).toContain(`Página ${n} de ${proxy.numPages}`);
    }
    // Every indication is printed, and none twice.
    const all = await textOf(pdf);
    for (let line = 1; line <= 12; line += 1) {
      expect(all).toContain(`Línea ${line}`);
    }
  });
});

describe('DOC-085 la tinta y las etiquetas del marco aprobado', () => {
  it('DOC-085 pinta el texto en tinta #1d2422 y las etiquetas en #4a5450, no en negro puro', async () => {
    const pdf = await renderer.render(layout, images, metadata);
    let streams = '';
    for (const match of pdf
      .toString('latin1')
      .matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
      try {
        streams += inflateSync(Buffer.from(match[1] ?? '', 'latin1')).toString(
          'latin1',
        );
      } catch {
        // Not a content stream (an embedded font, the ICC profile).
      }
    }
    const fills = [...streams.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) scn/g)].map(
      (fill) =>
        [fill[1], fill[2], fill[3]]
          .map((channel) => Math.round(Number(channel) * 255))
          .join(','),
    );

    expect(fills).toContain('29,36,34'); // #1d2422
    expect(fills).toContain('74,84,80'); // #4a5450
    expect(fills).not.toContain('0,0,0');
  });
});
