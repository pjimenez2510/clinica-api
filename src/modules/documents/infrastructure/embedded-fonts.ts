import { readFileSync } from 'node:fs';

/**
 * DOC-021, DOC-025. ⚠️ THE TRAP OF PDFKIT, AND THE MOST EXPENSIVE ONE IT HAS.
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
 * SOURCE SANS 3 AND SOURCE SERIF 4, FROM ADOBE'S OWN PACKAGES (D-095.2)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The approved template is set in them. `source-sans` and `source-serif` are
 * published on npm by Adobe, OFL-1.1, and carry the STATIC TTF of every weight.
 * Static and not variable: PDFKit embeds a variable font's default instance, so
 * the weight asked for would not be the weight printed. `@fontsource` was the
 * other candidate and ships only WOFF/WOFF2, which puts a decompression step
 * between the file and the PDF for no gain.
 *
 * They are packages of DATA: nothing executes, nothing to maintain. The price
 * is their size on disk (tens of megabytes, every format of every weight); the
 * PDF carries only the subset it uses.
 *
 * READ ONCE, AT MODULE LOAD, so a missing font stops the process at boot
 * rather than at the first document.
 */

/**
 * One static TTF of an Adobe font package.
 *
 * `require.resolve` and not a path built by hand: pnpm's store puts the package
 * under a content-addressed directory. The bare `require` because this project
 * compiles to CommonJS, where `import.meta` is a compile error.
 */
function loadFont(pkg: 'source-sans' | 'source-serif', file: string): Buffer {
  return readFileSync(require.resolve(`${pkg}/TTF/${file}`));
}

/** The names the renderer registers them under, and the faces behind them. */
export const FONTS = {
  /** Body text and values. */
  sans: loadFont('source-sans', 'SourceSans3-Regular.ttf'),
  /** The emphasised value: a patient's name, a drug. */
  sansSemibold: loadFont('source-sans', 'SourceSans3-Semibold.ttf'),
  /** Labels, table headers, CONFIDENCIAL. */
  sansBold: loadFont('source-sans', 'SourceSans3-Bold.ttf'),
  /** The establishment's name, the title and the headings. */
  serifBold: loadFont('source-serif', 'SourceSerif4-Bold.ttf'),
} as const;

export type FontName = keyof typeof FONTS;
