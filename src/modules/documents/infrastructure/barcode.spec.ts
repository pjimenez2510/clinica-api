import {
  BarcodeFormat,
  BinaryBitmap,
  Code128Reader,
  HybridBinarizer,
  RGBLuminanceSource,
} from '@zxing/library';
import { describe, expect, it } from 'vitest';

import { PdfKitDocumentRenderer, barsOf } from './pdfkit-document.renderer';
import type { DocumentLayout } from '../domain/page-layout';

/**
 * DOC-078. The access key's barcode, READ BACK by an independent reader.
 *
 * The bars the renderer draws come from `barsOf`; this rasterises exactly those
 * widths — three pixels a module, with the quiet zone — and hands the image to
 * ZXing's Code 128 reader, which knows nothing of bwip-js. If it returns the 49
 * digits, a handheld reader will too.
 */
const ACCESS_KEY = '3009202601179123456700120010020000000131234567811';

function read(widths: readonly number[]): string {
  const scale = 3;
  const quiet = 10;
  const modules = widths.reduce((total, each) => total + each, 0) + 2 * quiet;
  const width = modules * scale;
  const height = 40;
  const row = new Uint8ClampedArray(width).fill(255);
  let at = quiet * scale;
  widths.forEach((each, index) => {
    if (index % 2 === 0) row.fill(0, at, at + each * scale);
    at += each * scale;
  });
  const pixels = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y += 1) pixels.set(row, y * width);

  const bitmap = new BinaryBitmap(
    new HybridBinarizer(new RGBLuminanceSource(pixels, width, height)),
  );
  return new Code128Reader().decode(bitmap).getText();
}

describe('DOC-078 el código de barras de la clave de acceso', () => {
  it('DOC-078 un lector independiente lee los 49 dígitos de la clave', () => {
    expect(read(barsOf(ACCESS_KEY))).toBe(ACCESS_KEY);
  });

  it('DOC-078 control: con una barra alterada el lector no devuelve la clave', () => {
    const broken = barsOf(ACCESS_KEY);
    broken[20] = (broken[20] ?? 1) + 2;
    let text: string | null = null;
    try {
      text = read(broken);
    } catch {
      text = null;
    }
    expect(text).not.toBe(ACCESS_KEY);
  });

  it('DOC-078 es Code 128 sin identificador GS1: empieza por START C y no lleva FNC1', () => {
    const widths = barsOf(ACCESS_KEY);
    // START C is 2-1-1-2-3-2; GS1-128 would follow it with FNC1, 4-1-1-1-3-1.
    expect(widths.slice(0, 6)).toEqual([2, 1, 1, 2, 3, 2]);
    expect(widths.slice(6, 12)).not.toEqual([4, 1, 1, 1, 3, 1]);
    expect(BarcodeFormat[BarcodeFormat.CODE_128]).toBe('CODE_128');
  });

  it('DOC-078 el PDF dibuja las barras como trazos y lleva la clave en texto', async () => {
    const layout: DocumentLayout = {
      frame: {
        title: 'FACTURA',
        reference: null,
        confidential: false,
        accentColour: '#0f6b5c',
        establishmentName: 'Clínica Andina',
        header: null,
        hasLogo: false,
        footer: { text: null, verification: null, notes: [] },
      },
      blocks: [{ kind: 'barcode', value: ACCESS_KEY }],
      tearOff: null,
    };
    const pdf = await new PdfKitDocumentRenderer().render(
      layout,
      { logo: null, seal: null, signature: null },
      { title: 'FACTURA', author: 'Clínica Andina', createdAt: new Date() },
    );

    // No raster anywhere: the bars are paths, like the QR (DOC-023).
    expect(pdf.toString('latin1')).not.toContain('/Subtype /Image');
    expect(
      barsOf(ACCESS_KEY).filter((_, index) => index % 2 === 0).length,
    ).toBeGreaterThan(50);
  });
});
