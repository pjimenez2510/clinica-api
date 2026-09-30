import { Injectable } from '@nestjs/common';
import sharp from 'sharp';

import {
  MAX_IMAGE_PIXELS,
  assertAcceptableUpload,
  assertPixelsWithinBounds,
} from '../domain/document-image';
import { DocumentImageUnreadableError } from '../domain/document.errors';
import type {
  ImageNormaliser,
  NormalisedImage,
} from '../domain/document-rendering.port';
import type { ImageSlot } from '../domain/document-image';

/**
 * DOC-052 to DOC-055. The image, decoded under a cap and written back from its
 * pixels.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY SHARP, AND WHY THE ORDER OF THE STEPS IS THE DEFENCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The input is hostile by definition — anyone who can reach the administration
 * screen can send a file — and libvips is the decoder built for that: it has a
 * first-class `limitInputPixels`, it refuses truncated data with `failOn`, and
 * it strips metadata on output rather than as an option somebody remembers.
 * The pure-JavaScript alternatives (`pngjs` + `jpeg-js`) have neither a pixel
 * cap nor active maintenance, and they decode the whole bomb before anybody can
 * ask how big it was.
 *
 * THE ORDER:
 *
 *   1. THE BYTE CAP, in `assertAcceptableUpload`, on the buffer as it arrived
 *      (DOC-052). Decoding first and complaining afterwards is having already
 *      spent the memory the cap exists not to spend. The HTTP layer caps it too,
 *      through `express.raw({ limit })`, so a 50 MB body never reaches Node's
 *      heap at all — two caps at two depths, and the outer one is the cheap one.
 *   2. THE FORMAT, FROM THE MAGIC BYTES (DOC-050, DOC-051) — never from
 *      `Content-Type` or from a filename, which are whatever the client typed.
 *   3. THE PIXEL CAP, inside the decoder (DOC-053). A 40 KB PNG can declare
 *      30 000 × 30 000 pixels: the byte cap does not see it, and without
 *      `limitInputPixels` the process asks the kernel for gigabytes.
 *   4. THE RE-ENCODE (DOC-054), always, even PNG → PNG.
 *
 * ⚠️ THE ALPHA CHANNEL IS FLATTENED OVER WHITE (DOC-055), AND IT IS NOT
 * COSMETIC. PDF/A-1b FORBIDS TRANSPARENCY. A logo exported with a transparent
 * background — which is how every designer exports a logo — is embedded with a
 * soft mask, and every document that clinic ever emits stops validating as
 * PDF/A. Nobody would notice until an audit, which is the worst kind of defect:
 * silent, systematic and retroactive.
 */
@Injectable()
export class SharpImageNormaliser implements ImageNormaliser {
  async normalise(bytes: Buffer, slot: ImageSlot): Promise<NormalisedImage> {
    // Steps 1 and 2. Both are pure and live in the domain, so the order can be
    // asserted without a decoder.
    const declaredFormat = assertAcceptableUpload(bytes, slot);

    const pipeline = sharp(bytes, {
      // Step 3. The cap the byte cap cannot give.
      limitInputPixels: MAX_IMAGE_PIXELS,
      // A truncated or malformed file is REFUSED rather than silently repaired:
      // a repaired image is a file whose bytes nobody chose.
      failOn: 'error',
      // Only the first frame. An animated PNG would otherwise decode every one
      // of them to produce a logo nothing animates.
      animated: false,
    });

    let metadata: sharp.Metadata;
    try {
      metadata = await pipeline.metadata();
    } catch {
      throw new DocumentImageUnreadableError(slot);
    }

    assertPixelsWithinBounds(metadata.width ?? 0, metadata.height ?? 0, slot);

    try {
      // Step 4. FROM THE PIXELS, ALWAYS.
      //
      // `.flatten()` composites over white and drops the alpha channel; the
      // encoders below write no metadata of their own, so the EXIF, the ICC
      // profile and anything hidden in an ancillary chunk do not survive the
      // round trip. That is the point: what is stored is not the file, it is
      // the image.
      const flattened = pipeline.flatten({
        background: { r: 255, g: 255, b: 255 },
      });

      const output =
        declaredFormat === 'image/png'
          ? flattened.png({ compressionLevel: 9, palette: false })
          : // Baseline and not progressive: a progressive JPEG cannot be
            // embedded in a PDF.
            flattened.jpeg({ quality: 90, progressive: false, mozjpeg: false });

      const { data, info } = await output.toBuffer({ resolveWithObject: true });

      return {
        mimeType: declaredFormat,
        bytes: data,
        width: info.width,
        height: info.height,
      };
    } catch {
      throw new DocumentImageUnreadableError(slot);
    }
  }
}
