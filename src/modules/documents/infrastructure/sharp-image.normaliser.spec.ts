import { crc32, deflateSync } from 'node:zlib';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  DocumentImageTooLargeError,
  DocumentImageUnreadableError,
} from '../domain/document.errors';
import { SharpImageNormaliser } from './sharp-image.normaliser';

/**
 * DOC-053 against the REAL decoder. The domain rule (`assertPixelsWithinBounds`)
 * has its own tests; what only this adapter can get wrong is the ORDER of what
 * libvips does: with `limitInputPixels` on the pipeline, `metadata()` itself
 * refuses the bomb, and a blanket `catch` turned that into «unreadable» — the
 * person was told the file was broken, not that it was too big, and the
 * DOCUMENT_IMAGE_TOO_LARGE that DOC-053 names never reached anybody (found by
 * the F-08 walk, 07-10-2026).
 */

/** A well-formed PNG whose header DECLARES `width × height` grey pixels. */
function pngDeclaring(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(0, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(width + 1))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('SharpImageNormaliser', () => {
  const normaliser = new SharpImageNormaliser();

  it('DOC-053 una bomba de pocos bytes que declara 6400 × 6400 se rechaza por píxeles, no como ilegible', async () => {
    const bomb = pngDeclaring(6400, 6400);
    expect(bomb.length).toBeLessThan(1024);

    const refusal = await normaliser.normalise(bomb, 'logo').then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(DocumentImageTooLargeError);
    expect((refusal as DocumentImageTooLargeError).userTitle).toContain(
      'demasiados píxeles',
    );
  });

  it('DOC-053 control: una imagen pequeña de verdad se normaliza', async () => {
    const small = await sharp({
      create: { width: 40, height: 20, channels: 3, background: '#0f6b5c' },
    })
      .png()
      .toBuffer();

    const stored = await normaliser.normalise(small, 'logo');

    expect(stored).toMatchObject({
      mimeType: 'image/png',
      width: 40,
      height: 20,
    });
  });

  it('DOC-053 un PNG roto sigue siendo ilegible, no demasiado grande', async () => {
    const broken = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64, 7),
    ]);

    await expect(normaliser.normalise(broken, 'logo')).rejects.toBeInstanceOf(
      DocumentImageUnreadableError,
    );
  });
});
