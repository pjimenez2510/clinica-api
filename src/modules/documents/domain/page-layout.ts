/**
 * DOC-070 to DOC-073. The page, described without naming a PDF engine.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THE LAYOUT IS A DATA STRUCTURE AND NOT A SERIES OF DRAWING CALLS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `domain` may not import a framework — `pnpm arch:check` enforces it — and
 * PDFKit is a framework. But the rule is not why this shape exists; it is the
 * reason the rule is right here: WHAT THE RECETA SAYS is normative and testable
 * (art. 5 lists five blocks, and each one either appears or does not), while
 * HOW IT IS PAINTED is a rendering detail. Splitting them lets the first be
 * asserted with a plain object in a millisecond, and lets the second be
 * replaced the day PDFKit is no longer the answer, without touching a single
 * requirement.
 *
 * All measurements are in MILLIMETRES here and converted at the edge. A domain
 * that speaks in PostScript points has already leaked the engine into itself.
 */

/** A4, which is what every one of these documents is printed on. */
export const PAGE_WIDTH_MM = 210;
export const PAGE_HEIGHT_MM = 297;

/** DOC-070. Comfortable for a hole punch and for a laser printer's dead zone. */
export const PAGE_MARGIN_MM = 15;

/**
 * DOC-073. THE TEAR-OFF BAND, AND WHY ITS HEIGHT IS A CONSTANT.
 *
 * Art. 5.e of the Resolución ACESS-2023-0030 admits that the indications to the
 * patient go on a DETACHABLE block. That turns a sentence of the norm into a
 * requirement of PAGE GEOMETRY: if the cut line lands wherever the text happens
 * to end, it is not detachable — the pharmacist cuts through the posology on one
 * receta and through nothing on the next.
 *
 * So the band is reserved on EVERY page — the body never flows into it — and
 * the cut line sits at exactly this distance from the bottom edge, always.
 *
 * This is precisely what the browser print dialogue cannot promise: the
 * specification lets a browser ROTATE OR SCALE the page to make it fit, and
 * «Gráficos de fondo» arrives unticked. That is why the artefact is composed
 * here and not by `window.print()`.
 */
export const TEAR_OFF_HEIGHT_MM = 70;

/** Points per millimetre. PDF user space is 72 dpi. */
export const POINTS_PER_MM = 72 / 25.4;

/**
 * The norm and the margins are stated in millimetres; PDFKit draws in points.
 */
export function millimetresToPoints(millimetres: number): number {
  return millimetres * POINTS_PER_MM;
}

/** How a table column is laid out. `width` is a fraction of the text width. */
export interface TableColumn {
  header: string;
  width: number;
  align?: 'left' | 'right' | 'centre';
}

/** One labelled value. The label is printed in bold, the value beside it. */
export interface LabelledValue {
  label: string;
  value: string;
}

/**
 * Which stored image a signature block should print, if there is one.
 *
 * `null` prints a LABELLED EMPTY BOX (DOC-060). The system cannot manufacture a
 * seal, and a generated squiggle would be a forged one — art. 5.d.iii is
 * textual: «no se aceptarán rúbricas o trazos por firma». An empty labelled box
 * is a document missing a seal, which is honest; a drawn one is a lie.
 */
export type SignatureImageSlot = 'seal' | 'signature' | null;

/** Everything that can appear in the body of a document. */
export type Block =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string; readonly emphasis?: boolean } // prettier-ignore
  | { readonly kind: 'fields'; readonly columns: 1 | 2 | 3; readonly entries: readonly LabelledValue[] } // prettier-ignore
  | { readonly kind: 'table'; readonly columns: readonly TableColumn[]; readonly rows: readonly (readonly string[])[] } // prettier-ignore
  | { readonly kind: 'spacer'; readonly millimetres: number }
  | { readonly kind: 'rule' }
  | { readonly kind: 'signature'; readonly caption: string; readonly image: SignatureImageSlot } // prettier-ignore
  /**
   * Two framed boxes side by side.
   *
   * It exists for the RIDE (DOC-076): the SRI's Anexo 2 puts the issuer's data
   * and the voucher's identification in two boxes at the head of the page, and
   * that is a geometry, not a flow. Generic rather than `rideHeader` because
   * nothing about two boxes is specific to a tax document.
   */
  | { readonly kind: 'boxes'; readonly left: readonly Block[]; readonly right: readonly Block[] }; // prettier-ignore

/** DOC-071. What repeats on every page. */
export interface DocumentHeader {
  /** Art. 5.a.iii — the only establishment datum the receta MUST carry. */
  establishmentName: string;
  /** DOC-034. Printed only when the template's switch says so. */
  establishmentRuc: string | null;
  establishmentAddress: string | null;
  establishmentPhone: string | null;
  /** DOC-059. `null` prints no logo, and that is legitimate. */
  hasLogo: boolean;
  /** DOC-036. The template's key-value slots. */
  fields: readonly LabelledValue[];
}

/** DOC-073. The detachable band at the foot of the receta. */
export interface TearOffBand {
  /** Printed above the cut line so the strip says what it is. */
  caption: string;
  /**
   * Repeated inside the band. A detached strip with no name on it is a loose
   * piece of paper that does not say whose it is.
   */
  identification: readonly LabelledValue[];
  blocks: readonly Block[];
}

/** A whole document, ready to be painted. */
export interface DocumentLayout {
  title: string;
  /** The verification code, the sequential — whatever identifies this document. */
  reference: string | null;
  accentColour: string;
  header: DocumentHeader;
  blocks: readonly Block[];
  /** Only the receta has one. */
  tearOff: TearOffBand | null;
  footerText: string | null;
}
