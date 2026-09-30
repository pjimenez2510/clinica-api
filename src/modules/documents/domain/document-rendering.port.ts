import type { StoredImage } from './document-image';
import type { DocumentLayout } from './page-layout';

/**
 * The two things this module cannot do in pure TypeScript: paint a PDF and
 * decode an image. Both are PORTS, and both adapters live in
 * `infrastructure/`.
 *
 * WHY THEY ARE PORTS AND NOT DIRECT CALLS. `domain` may not import a framework
 * and `pnpm arch:check` enforces it — but the rule is not the reason, it is the
 * consequence of one: what the receta SAYS is normative and must be assertable
 * with a plain object in a millisecond, while how it is PAINTED is a rendering
 * detail that should be replaceable the day PDFKit is no longer the answer.
 */

/** The images a layout may reference, resolved once before painting. */
export interface LayoutImages {
  /** DOC-059. `null` prints no logo, which is legitimate. */
  logo: StoredImage | null;
  /** DOC-060. `null` prints a labelled empty box, never a drawn seal. */
  seal: StoredImage | null;
  signature: StoredImage | null;
}

/** DOC-024. What goes into the PDF's own metadata. */
export interface DocumentMetadata {
  title: string;
  /** The establishment. A PDF/A says who produced it. */
  author: string;
  /**
   * DOC-024. THE INSTANT OF EMISSION, not the machine's clock. A creation date
   * taken from `new Date()` inside the renderer turns two identical documents
   * into two different files, and the `sha256` stops meaning anything.
   */
  createdAt: Date;
}

/**
 * The port `PdfKitDocumentRenderer` implements. It paints a layout that is
 * already decided; it composes nothing.
 */
export interface DocumentRenderer {
  /**
   * DOC-020 to DOC-024. Paints the layout and returns the PDF/A-1b bytes.
   *
   * Throws `DocumentRenderFailedError` and nothing else: a caller should never
   * have to know what engine failed.
   */
  render(
    layout: DocumentLayout,
    images: LayoutImages,
    metadata: DocumentMetadata,
  ): Promise<Buffer>;
}

export const DOCUMENT_RENDERER = Symbol('DOCUMENT_RENDERER');

/** DOC-054 to DOC-056. One image, decoded and written back from its pixels. */
export interface NormalisedImage {
  mimeType: 'image/png' | 'image/jpeg';
  bytes: Buffer;
  width: number;
  height: number;
}

/**
 * The port `SharpImageNormaliser` implements. Called before any image is stored
 * (DOC-054).
 */
export interface ImageNormaliser {
  /**
   * DOC-053 to DOC-055. Decodes with a pixel cap, flattens the alpha channel
   * over white and writes the image back from its pixels.
   *
   * ⚠️ IT NEVER RETURNS THE BYTES IT WAS GIVEN, even when the input format and
   * the output format are the same. Re-encoding is what removes metadata, odd
   * colour profiles and MIXED PAYLOADS — the file that is a valid PNG and also
   * something else. That the two formats match does not make the step
   * redundant: what is stored is not the file, it is the pixels.
   */
  normalise(bytes: Buffer, slot: 'logo' | 'seal' | 'signature'): Promise<NormalisedImage>; // prettier-ignore
}

export const IMAGE_NORMALISER = Symbol('IMAGE_NORMALISER');
