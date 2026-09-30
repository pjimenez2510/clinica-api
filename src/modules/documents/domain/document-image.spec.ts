import { describe, expect, it } from 'vitest';

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  assertAcceptableUpload,
  assertPixelsWithinBounds,
  detectImageFormat,
} from './document-image';
import {
  DocumentImageFormatNotAllowedError,
  DocumentImageTooLargeError,
} from './document.errors';

/**
 * DOC-050 to DOC-053. What can be decided about a hostile file before anything
 * decodes it — and, just as importantly, IN WHAT ORDER.
 */

const png = (payload = 32): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(payload),
  ]);

const jpeg = (payload = 32): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(payload)]);

const svg = (): Buffer =>
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/steal")</script></svg>',
  );

describe('DOC-050, DOC-051 el formato se decide por los bytes, no por la etiqueta', () => {
  it('DOC-050 reconoce PNG por su firma de ocho bytes', () => {
    expect(detectImageFormat(png())).toBe('image/png');
  });

  it('DOC-050 reconoce JPEG por su marcador SOI', () => {
    expect(detectImageFormat(jpeg())).toBe('image/jpeg');
  });

  it('DOC-051 rechaza el SVG, que es el que ejecuta scripts', () => {
    // Not paranoia: an SVG DOES execute scripts when navigated to directly, and
    // there are real CVEs of credential theft through exactly that path.
    // «Sólo lo pintamos en un `img`» holds until somebody opens the image in a
    // new tab. Stripe, with an unlimited security budget, accepts «JPG or PNG»
    // and no SVG.
    expect(detectImageFormat(svg())).toBeNull();
    expect(() => assertAcceptableUpload(svg(), 'logo')).toThrow(
      DocumentImageFormatNotAllowedError,
    );
  });

  it('DOC-050 rechaza un SVG aunque se envíe con la extensión y el tipo de un PNG', () => {
    // THE DEFENCE IS THE BYTES. A `Content-Type` is whatever the client typed,
    // and a filename even less than that.
    const disguised = svg();
    expect(detectImageFormat(disguised)).toBeNull();
  });

  it('DOC-050 rechaza GIF, WebP y cualquier otra cosa, sin lista de excepciones', () => {
    const gif = Buffer.from('GIF89a________');
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBP'),
    ]);
    const pdf = Buffer.from('%PDF-1.7');

    for (const candidate of [gif, webp, pdf]) {
      expect(detectImageFormat(candidate)).toBeNull();
    }
  });

  it('DOC-050 rechaza un PNG cuya firma está a medias', () => {
    // Requiring all eight signature bytes catches a transfer that mangled line
    // endings, which is exactly what the `\r\n` and the ^Z inside the signature
    // were designed to detect.
    const truncated = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x0a]);
    expect(detectImageFormat(truncated)).toBeNull();
  });
});

describe('DOC-052 el tope de bytes se aplica ANTES de decodificar', () => {
  it('DOC-052 rechaza por tamaño un fichero que además sería de formato válido', () => {
    // THE ORDER IS THE DEFENCE. This buffer is a perfectly good PNG signature:
    // if the format were checked first and the size afterwards, the megabyte
    // would already have been handled.
    const huge = png(MAX_IMAGE_BYTES);
    const rejection = (): unknown => assertAcceptableUpload(huge, 'logo');

    expect(rejection).toThrow(DocumentImageTooLargeError);
    try {
      rejection();
    } catch (error) {
      expect((error as DocumentImageTooLargeError).params.reason).toBe('bytes');
    }
  });

  it('DOC-052 rechaza un cuerpo vacío', () => {
    expect(() => assertAcceptableUpload(Buffer.alloc(0), 'seal')).toThrow(
      DocumentImageTooLargeError,
    );
  });

  it('DOC-052 acepta lo que cabe y devuelve el formato real', () => {
    expect(assertAcceptableUpload(png(), 'logo')).toBe('image/png');
    expect(assertAcceptableUpload(jpeg(), 'signature')).toBe('image/jpeg');
  });
});

describe('DOC-053 el tope de píxeles, que el de bytes no cubre', () => {
  it('DOC-053 rechaza una bomba de descompresión', () => {
    // A 40 KB PNG can declare 30 000 × 30 000 pixels and ask the kernel for
    // several gigabytes when decoded. The byte cap never sees it: the two caps
    // measure different things and both are needed.
    const rejection = (): void =>
      assertPixelsWithinBounds(30_000, 30_000, 'logo');

    expect(rejection).toThrow(DocumentImageTooLargeError);
    try {
      rejection();
    } catch (error) {
      expect((error as DocumentImageTooLargeError).params.reason).toBe(
        'pixels',
      );
    }
  });

  it('DOC-053 rechaza dimensiones imposibles', () => {
    expect(() => assertPixelsWithinBounds(0, 100, 'seal')).toThrow(
      DocumentImageTooLargeError,
    );
    expect(() => assertPixelsWithinBounds(100, -1, 'seal')).toThrow(
      DocumentImageTooLargeError,
    );
  });

  it('DOC-053 acepta un logo de tamaño razonable', () => {
    expect(() => assertPixelsWithinBounds(1200, 400, 'logo')).not.toThrow();
    // Exactly at the ceiling is accepted: the cap is «no more than».
    const side = Math.floor(Math.sqrt(MAX_IMAGE_PIXELS));
    expect(() => assertPixelsWithinBounds(side, side, 'logo')).not.toThrow();
  });
});
