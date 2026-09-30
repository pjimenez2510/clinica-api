import { readFileSync } from 'node:fs';

/**
 * DOC-021. ⚠️ THE TRAP OF PDFKIT, AND THE MOST EXPENSIVE ONE IT HAS.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FOURTEEN STANDARD FONTS ARE METRICS ONLY AND CANNOT BE EMBEDDED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PDFKit ships the AFM metrics of Helvetica, Times-Roman, Courier and their
 * variants. It does NOT ship the fonts: there is no outline data to embed, so a
 * document that uses them comes out with `/BaseFont /Helvetica` and no
 * `FontFile2` anywhere. PDF/A requires EVERY font to be embedded, so such a
 * file is not PDF/A — and PDFKit does not warn: it produces a perfectly legible
 * PDF that fails only in a validator, months later, during an audit.
 *
 * Verified by running it, not by reading about it (20-08-2026): the same
 * document built with `subset: 'PDF/A-1b'` contains `FontFile2` when a TTF is
 * registered and contains none when it is not.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FONT TRAVELS WITH THE APPLICATION, NOT WITH THE OPERATING SYSTEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `dejavu-fonts-ttf` — DejaVu Sans, a free licence derived from Bitstream Vera,
 * with complete Latin coverage including the accents and the «ñ» that every one
 * of these documents needs. It is a package of DATA: it executes nothing, has no
 * dependencies and needs no maintenance, so its publication date is not the
 * signal it would be in a library.
 *
 * A system font — `/System/Library/Fonts`, `fontconfig` — would make the PDF/A
 * depend on the machine that produced it, which is exactly what an archival
 * format exists to prevent.
 *
 * READ ONCE, AT MODULE LOAD. Three quarters of a megabyte held for the life of
 * the process, against a file read on every document. PDFKit subsets what it
 * embeds, so the buffer's size is not the PDF's size.
 */

/**
 * One TTF of `dejavu-fonts-ttf`, read synchronously. It runs at module load, so
 * a missing font stops the process at boot rather than at the first document.
 */
function loadFont(file: string): Buffer {
  // `require.resolve` and not a path built by hand: pnpm's store puts the
  // package under a content-addressed directory, so `../../node_modules/…`
  // would be a path that happens to work on one machine and on no other.
  //
  // The bare `require` and not `createRequire(import.meta.url)`: this project
  // compiles to CommonJS (`tsconfig`), where `import.meta` is a compile error.
  return readFileSync(require.resolve(`dejavu-fonts-ttf/ttf/${file}`));
}

/** The face every document is set in. */
export const REGULAR_FONT: Buffer = loadFont('DejaVuSans.ttf');

/** Headings, labels and the emphasis of an annulled document. */
export const BOLD_FONT: Buffer = loadFont('DejaVuSans-Bold.ttf');

/** The names the renderer registers them under. */
export const FONT_REGULAR = 'body';
export const FONT_BOLD = 'body-bold';
