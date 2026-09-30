import {
  DocumentImageFormatNotAllowedError,
  DocumentImageTooLargeError,
} from './document.errors';

/**
 * DOC-050 to DOC-056. What a printable image is allowed to be, decided BEFORE
 * anything decodes it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE, AND THAT IS WHAT MAKES THE ORDER OF THE CHECKS TESTABLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The order is the defence, not a detail:
 *
 *   1. THE BYTE CAP, first of all, on the buffer as it arrived. Decoding to
 *      find out it was too big is having already spent the memory the cap
 *      exists not to spend.
 *   2. THE FORMAT, from the MAGIC BYTES and never from the declared
 *      `Content-Type` or the filename. A header is whatever the client typed.
 *   3. Only then the decode, in the adapter, with its own pixel cap.
 *
 * ⚠️ SVG IS REFUSED, AND IT IS NOT PARANOIA (D-A-015). An SVG DOES execute
 * scripts when it is navigated to directly — «sólo lo pintamos en un `img`»
 * holds until somebody opens the image in a new tab — and there are real CVEs
 * of credential theft through exactly that path. Two commonly repeated beliefs
 * are false: SVGO is a MINIFIER and not a sanitiser (811 bytes of nested
 * entities take Node down through its own CVE), and OWASP has NO guidance on
 * SVG, so whoever cites it cites something that does not exist. Stripe, with an
 * unlimited security budget, accepts «JPG or PNG, less than 512kb» and no SVG.
 */

/** DOC-052. The same figure Stripe publishes, and for the same reason. */
export const MAX_IMAGE_BYTES = 512 * 1024;

/**
 * DOC-053. Roughly a 6300 × 6300 image: far beyond any logo, far below what
 * hurts.
 *
 * A BYTE CAP DOES NOT COVER THIS. A 40 KB PNG can declare 30 000 × 30 000
 * pixels and ask for several gigabytes when decoded, which is a denial of
 * service that passes every size check. The two caps measure different things.
 */
export const MAX_IMAGE_PIXELS = 40_000_000;

/** DOC-050. The two the database also enforces (`document_image_mime_type_allowed`). */
export const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/** Which slot the image is being uploaded into. Only used to name the field. */
export type ImageSlot = 'logo' | 'seal' | 'signature';

/**
 * The format the BYTES say they are.
 *
 * `null` for everything else, which is deliberately the same answer for an SVG,
 * a GIF, a WebP, a PDF and a zip: the allowlist is what decides, so there is no
 * per-format branch to forget to close.
 */
export function detectImageFormat(bytes: Buffer): AllowedImageMimeType | null {
  // PNG: the eight-byte signature of RFC 2083. The `\r\n` and the ^Z inside it
  // exist to catch transfers that mangled line endings, so checking all eight
  // is worth more than checking the first four.
  const PNG_SIGNATURE = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return 'image/png';
  }

  // JPEG: SOI marker, and the last two bytes are EOI. Requiring both refuses a
  // truncated upload here rather than three layers deeper, where the decoder
  // would report it as a corrupt file.
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  return null;
}

/**
 * DOC-050 to DOC-053. Everything that can be decided without decoding.
 *
 * Returns the format the bytes really are. Throws otherwise — and the byte cap
 * is checked FIRST, on purpose (see the header of this file).
 */
export function assertAcceptableUpload(
  bytes: Buffer,
  slot: ImageSlot,
): AllowedImageMimeType {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new DocumentImageTooLargeError(slot, 'bytes');
  }

  const format = detectImageFormat(bytes);
  if (format === null) throw new DocumentImageFormatNotAllowedError(slot);

  return format;
}

/** DOC-053, checked once the decoder has reported the real dimensions. */
export function assertPixelsWithinBounds(
  width: number,
  height: number,
  slot: ImageSlot,
): void {
  if (width <= 0 || height <= 0 || width * height > MAX_IMAGE_PIXELS) {
    throw new DocumentImageTooLargeError(slot, 'pixels');
  }
}

/** DOC-056. One stored image, as the rest of the module sees it. */
export interface StoredImage {
  id: string;
  mimeType: AllowedImageMimeType;
  bytes: Buffer;
  byteSize: number;
  sha256: string;
  width: number;
  height: number;
}

/** The metadata of a stored image, without dragging the bytes out of TOAST. */
export type StoredImageSummary = Omit<StoredImage, 'bytes'>;
