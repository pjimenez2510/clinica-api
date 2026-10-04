import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import QRCode from 'qrcode';

import { DocumentRenderFailedError } from '../domain/document.errors';
import {
  PAGE_MARGIN_MM,
  PAGE_WIDTH_MM,
  TEAR_OFF_HEIGHT_MM,
  millimetresToPoints,
} from '../domain/page-layout';
import { FONTS, type FontName } from './embedded-fonts';
import type {
  DocumentMetadata,
  DocumentRenderer,
  LayoutImages,
} from '../domain/document-rendering.port';
import type {
  Block,
  DocumentLayout,
  LabelledValue,
  SectionRow,
  TableColumn,
} from '../domain/page-layout';

/**
 * DOC-020 to DOC-025, DOC-070 to DOC-085. The layout, painted as PDF/A-1b in
 * the frame of the approved template (D-095).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY PDFKIT, AND WHAT IT WAS CHOSEN AGAINST
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It is THE ONLY JavaScript library that generates native PDF/A — 1b, 2b, 3b
 * and the «a» variants — and the international clinical standard (IHE) requires
 * PDF/A-1b for shared documents. `pdf-lib` is DEAD (nothing published since
 * November 2021); headless Chromium costs 750–900 MB of image, ~2 s per
 * document, zombie processes, and produces NO PDF/A; Gotenberg is a second
 * piece to operate and rasterises coloured table cells; Typst is pre-1.0 with a
 * single-maintainer Node binding; wkhtmltopdf is archived; mupdf and
 * Vivliostyle are AGPL-3.0.
 *
 * The argument that closes it is the one ADR-001 used to choose pg-boss over
 * BullMQ: «cero infraestructura nueva … para un despliegue en nube con equipo
 * pequeño, esto es lo que más pesa». It holds word for word against Chromium.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT MAKES THE OUTPUT ACTUALLY PDF/A, AND NOT JUST A PDF
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   - `subset: 'PDF/A-1b'` — PDFKit then writes the `OutputIntent` with the
 *     sRGB IEC61966-2.1 ICC profile and the `pdfaid` XMP metadata (DOC-022).
 *   - A REGISTERED TTF before the first character (DOC-021). See
 *     `embedded-fonts.ts`: the fourteen standard fonts are metrics only and
 *     cannot be embedded, and PDFKit does not warn.
 *   - `pdfVersion: '1.4'` — PDF/A-1 is built on PDF 1.4.
 *   - NO TRANSPARENCY, NO ENCRYPTION, NO ATTACHMENTS (DOC-023). The alpha
 *     channel is the one that arrives by itself, through a PNG logo, and it is
 *     flattened in the image normaliser rather than trusted not to appear.
 *   - `info.CreationDate` set to the instant of emission and not to the
 *     machine's clock (DOC-024).
 */

/** DOC-025. The faces of `embedded-fonts.ts`, by the role they play. */
const SANS: FontName = 'sans';
const SANS_SEMIBOLD: FontName = 'sansSemibold';
const SANS_BOLD: FontName = 'sansBold';
const SERIF_BOLD: FontName = 'serifBold';

/**
 * DOC-085. The approved template's palette (D-095). The accent comes from the
 * template; red is reserved for CONFIDENCIAL and what a composer emphasises.
 */
const INK = '#1d2422';
const LABEL = '#4a5450';
const RULE_STRONG = '#b7c0bc';
const RULE_LIGHT = '#dde3e0';
const EMPTY_BOX = '#8a948f';
const ALERT = '#8a2c1f';
/** DOC-104. The band of general data. */
const STRIP_FILL = '#f2f5f4';
/** DOC-105, DOC-106. Title bars and table headers of the framed blocks. */
const BAR_FILL = '#e6ecea';
/** DOC-075. The ink of an informative note: the template's #3b4541. */
const NOTE_INK = '#3b4541';
/** DOC-038. The sample mark: light enough to read the document through. */
const WATERMARK = '#e1e6e4';

/** Short alias: every coordinate below is written in millimetres. */
const mm = millimetresToPoints;

/**
 * Type sizes, in points: the template's pixels × 0.75 (794 px = 210 mm). One
 * place, so a document cannot drift by section.
 */
const SIZE = {
  name: 15,
  title: 13.5,
  /** DOC-106. The issuer's razón social in its box: the template's 15 px. */
  boxName: 11.25,
  heading: 10.5,
  reference: 9.75,
  body: 9,
  label: 7.5,
  /** DOC-105. The labels of a form's cells: the template's 9 px. */
  cell: 6.75,
} as const;
const LINE_GAP = 1.5;

/** What a heading reserves before it is painted. */
const HEADING_HEIGHT = mm(9);
/** The signature box with its caption. */
const SIGNATURE_HEIGHT = mm(26);
/** DOC-057, DOC-060. The template's box for the seal: 210 × 70 px. */
const SIGNATURE_BOX_MM = { width: 55, height: 18 } as const;
/** DOC-105. The seal's column inside block E of the 117, and its box. */
const SECTION_SIGNATURE_MM = { column: 53, height: 20 } as const;
/** The room between a block of fields and the seal beside it. */
const SIGNATURE_GAP_MM = 5;

/**
 * DOC-071, DOC-083. Reserved at the foot of every page: room for FOUR rows —
 * the code, the verification URL, the class's note and the clinic's own
 * footer. With three, the clinic's footer was the one silently dropped.
 */
const FOOTER_HEIGHT_MM = 18;
/** DOC-078. The height of the access key's bars. */
const BARCODE_HEIGHT_MM = 12;
/** DOC-083. The QR's side. Readable by a phone at arm's length. */
const QR_SIZE_MM = 13;
/** DOC-059. The logo's box in the common header: the template's 88 × 64 px. */
const LOGO_BOX_MM = { width: 23, height: 17 } as const;
/** DOC-106. The RIDE's logo, above the issuer: the template's 84 px high. */
const RIDE_LOGO_HEIGHT_MM = 22;
/** DOC-080. The right-hand column: title, reference, CONFIDENCIAL. */
const TITLE_COLUMN_MM = 62;
/** DOC-106. The radius of the RIDE's boxes: the template's 6 px. */
const BOX_RADIUS_MM = 1.6;
/** DOC-104. The radius of the grey band: the template's 4 px. */
const STRIP_RADIUS_MM = 1.1;
/** The room left after a framed block, before whatever follows it. */
const BLOCK_GAP_MM = 3;

/**
 * The vertical position on the current page, shared by reference between the
 * painting steps so each one continues where the previous stopped.
 */
interface Cursor {
  y: number;
}

/**
 * Makes room for `height` points; `true` when that took a new page. A table
 * needs to know, to repeat its header and close its frame there.
 */
type Ensure = (height: number) => boolean;

/** Inside a box nothing turns a page: the box was measured whole beforehand. */
const NEVER_BREAKS: Ensure = () => false;

/** The blocks that are framed, and painted whole or in pieces. */
type Framed = Extract<Block, { kind: 'box' | 'boxes' | 'section' }>;

/**
 * DOC-071. How much a framed block may take: a whole page's body, and what
 * is left of the current one.
 */
interface Room {
  page: number;
  left: () => number;
}

/** Inside a box, or measuring: nothing is cut. */
const UNBOUNDED: Room = { page: Infinity, left: () => Infinity };

/** Tall enough that measuring a block never turns a page. */
const MEASURING_PAGE_HEIGHT = 100_000;

/** A row of a `fields` grid: each entry with its first column and its span. */
type FieldRow = { entry: LabelledValue; column: number; span: number }[];

/**
 * The `DocumentRenderer` adapter. It paints what `composeLayout` decided and
 * decides nothing about what a document says.
 */
@Injectable()
export class PdfKitDocumentRenderer implements DocumentRenderer {
  /**
   * Wraps every engine failure in `DocumentRenderFailedError`, the only error
   * the port admits.
   */
  async render(
    layout: DocumentLayout,
    images: LayoutImages,
    metadata: DocumentMetadata,
  ): Promise<Buffer> {
    try {
      return await this.compose(layout, images, metadata);
    } catch (cause) {
      // The caller never learns which engine failed: a PDF stack trace says
      // nothing to a receptionist and can carry a field value out with it.
      throw new DocumentRenderFailedError(cause);
    }
  }

  /**
   * Builds the whole PDF in memory and resolves with its bytes when PDFKit ends
   * the stream. Body blocks flow page by page above the reserved footer and
   * tear-off band; footers are painted last, once the page count is known.
   */
  private compose(
    layout: DocumentLayout,
    images: LayoutImages,
    metadata: DocumentMetadata,
  ): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      margin: mm(PAGE_MARGIN_MM),
      subset: 'PDF/A-1b',
      pdfVersion: '1.4',
      // Needed for «página N de M»: the total is not known until the last page
      // exists, so the footer is painted in a second pass.
      bufferPages: true,
      autoFirstPage: false,
      info: {
        Title: metadata.title,
        Author: metadata.author,
        Creator: 'clinica-api',
        Producer: 'clinica-api',
        CreationDate: metadata.createdAt,
      },
    });

    // DOC-021. BEFORE THE FIRST CHARACTER. Registering after any text has been
    // written leaves that text set in a font that cannot be embedded, and the
    // file stops being PDF/A without anything saying so.
    for (const name of Object.keys(FONTS) as FontName[]) {
      doc.registerFont(name, FONTS[name]);
    }

    const chunks: Buffer[] = [];
    const finished = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const left = mm(PAGE_MARGIN_MM);
    const accent = layout.frame.accentColour;

    // The first page is added by hand (`autoFirstPage: false`) so the fonts are
    // registered before anything can be written in one that cannot be embedded.
    doc.addPage();
    const contentWidth =
      doc.page.width - mm(PAGE_MARGIN_MM) - mm(PAGE_MARGIN_MM);

    /**
     * DOC-073. THE BODY NEVER FLOWS INTO THE TEAR-OFF BAND.
     *
     * Reserving it on every page — not only on the last — is what makes the cut
     * line land at a FIXED distance from the bottom edge on every sheet. A cut
     * line that follows the text is not detachable: the pharmacist cuts through
     * the posology on one receta and through nothing on the next.
     */
    const bottomLimit = footerTopOf(doc, layout) - mm(3);

    const cursor: Cursor = { y: 0 };
    /** Where the body of the current page starts, under its header. */
    let bodyTop = 0;

    const startPage = (): void => {
      cursor.y = mm(PAGE_MARGIN_MM);
      this.paintWatermark(doc, layout.frame.watermark);
      this.paintHeader(doc, layout, images, left, contentWidth, cursor);
      bodyTop = cursor.y;
    };

    const ensure: Ensure = (height) => {
      if (cursor.y + height <= bottomLimit) return false;
      // Already at the top of an empty page, a new one would only leave this
      // one blank: whatever does not fit here does not fit anywhere, and the
      // caller has to cut it (`piecesOf`).
      if (cursor.y <= bodyTop) return false;
      doc.addPage();
      startPage();
      return true;
    };

    startPage();
    /** A page's body, and what is left of the current one. */
    const room: Room = {
      page: bottomLimit - bodyTop,
      left: () => bottomLimit - cursor.y,
    };

    for (let index = 0; index < layout.blocks.length; index += 1) {
      const group = this.signedGroupHeight(doc, layout.blocks, index, contentWidth); // prettier-ignore
      // Only a short group: a long one flows row by row, as any block does.
      if (group !== null && group < (bottomLimit - mm(PAGE_MARGIN_MM)) / 2) {
        ensure(group);
      }
      index += this.paintBlockAt(doc, layout.blocks, index, images, left, contentWidth, cursor, ensure, accent, room); // prettier-ignore
    }

    // DOC-073. The band goes on the page the document ends on, at its fixed
    // position — not wherever the text stopped.
    if (layout.tearOff !== null) {
      this.paintTearOff(doc, layout, images, left, contentWidth, () => {
        doc.addPage();
        startPage();
        return { top: cursor.y, bottom: bottomLimit };
      });
    }

    this.paintFooters(doc, layout, left, contentWidth);

    doc.end();
    return finished;
  }

  /**
   * DOC-038. The sample mark, diagonal across the page and painted FIRST, so
   * the content sits on top of it. A light opaque grey and not a transparent
   * black: PDF/A-1b forbids transparency (DOC-023).
   */
  private paintWatermark(
    doc: PDFKit.PDFDocument,
    watermark: string | null,
  ): void {
    if (watermark === null) return;
    const { width, height } = doc.page;
    doc.save();
    doc.rotate(-35, { origin: [width / 2, height / 2] });
    doc
      .font(SANS_BOLD)
      .fontSize(54)
      .fillColor(WATERMARK)
      .text(watermark, 0, height / 2 - 30, {
        width,
        align: 'center',
        lineBreak: false,
      });
    doc.restore();
  }

  // ── header ───────────────────────────────────────────────────────────────

  /**
   * DOC-071, DOC-080 to DOC-082. The establishment and the document's title on
   * EVERY page.
   *
   * This is what `@media print` cannot promise: WebKit has never repeated
   * `<thead>` when printing — the bug has been open since 2008 — so a clinic on
   * Safari prints a broken receta and nobody finds out.
   *
   * DOC-103. THE THREE COLUMNS ARE CENTRED ON EACH OTHER, as the template's
   * `align-items: center`: each one is measured first, the tallest sets the
   * header's height, and the others are placed in its middle. Painting them
   * from the same top left the logo stuck to the edge of a taller text block.
   */
  private paintHeader(
    doc: PDFKit.PDFDocument,
    layout: DocumentLayout,
    images: LayoutImages,
    left: number,
    width: number,
    cursor: Cursor,
  ): void {
    const { frame } = layout;
    const header = frame.header;

    // DOC-076, DOC-084. The RIDE has its own head (Anexo 2), logo included:
    // its composer places it, above the issuer's box (DOC-106).
    if (header === null) return;

    const top = cursor.y;
    const titleWidth = mm(TITLE_COLUMN_MM);
    const titleLeft = left + width - titleWidth;

    // DOC-059. No logo, nothing drawn: not an empty box on the paper.
    const logo =
      header.hasLogo && images.logo !== null
        ? { bytes: images.logo.bytes, ...this.fitted(images.logo, mm(LOGO_BOX_MM.width), mm(LOGO_BOX_MM.height)) } // prettier-ignore
        : null;
    const textLeft =
      logo === null ? left : left + mm(LOGO_BOX_MM.width) + mm(4);
    const textWidth = titleLeft - mm(4) - textLeft;

    const contact = [
      header.establishmentAddress,
      header.establishmentPhone,
      header.establishmentEmail,
    ];
    const registry = [
      header.establishmentRuc === null
        ? null
        : `RUC ${header.establishmentRuc}`,
      header.operatingPermit === null
        ? null
        : `Permiso de funcionamiento ${header.operatingPermit}`,
      ...header.fields.map((field) => `${field.label}: ${field.value}`),
    ];

    /** One line of a column: its face, size, colour, and the room after it. */
    type Line = {
      text: string;
      font: FontName;
      size: number;
      colour: string;
      spacing?: number;
      gap: number;
    };
    const establishment: Line[] = [
      { text: header.establishmentName, font: SERIF_BOLD, size: SIZE.name, colour: INK, gap: 0 }, // prettier-ignore
      // DOC-081. Only with several sites; the composer of the frame decided it.
      ...(header.siteLine === null
        ? []
        : [{ text: header.siteLine, font: SANS_SEMIBOLD, size: SIZE.body, colour: frame.accentColour, gap: 1 }]), // prettier-ignore
      ...[contact, registry]
        .map((line) =>
          line
            .filter((entry): entry is string => entry !== null && entry !== '')
            .join(' · '),
        )
        .filter((text) => text !== '')
        .map((text) => ({ text, font: SANS, size: SIZE.body, colour: LABEL, gap: 1 })), // prettier-ignore
    ];
    const title: Line[] = [
      { text: frame.title, font: SERIF_BOLD, size: SIZE.title, colour: frame.accentColour, spacing: 0.4, gap: 0 }, // prettier-ignore
      ...(frame.reference === null
        ? []
        : [{ text: frame.reference, font: SANS_BOLD, size: SIZE.reference, colour: INK, gap: 2 }]), // prettier-ignore
      // DOC-082. A.M. 5216-A art. 33: health information is confidential, and
      // the legend says so on exactly the papers that carry a diagnosis.
      ...(frame.confidential
        ? [{ text: 'CONFIDENCIAL', font: SANS_BOLD, size: SIZE.label, colour: ALERT, spacing: 0.6, gap: 2 }] // prettier-ignore
        : []),
    ];

    const heightOf = (lines: Line[], columnWidth: number): number =>
      lines.reduce(
        (total, line) =>
          total +
          line.gap +
          doc
            .font(line.font)
            .fontSize(line.size)
            .heightOfString(line.text, {
              width: columnWidth,
              characterSpacing: line.spacing ?? 0,
            }),
        0,
      );
    const paint = (
      lines: Line[],
      x: number,
      y: number,
      columnWidth: number,
      align: 'left' | 'right',
    ): void => {
      let at = y;
      for (const line of lines) {
        doc
          .font(line.font)
          .fontSize(line.size)
          .fillColor(line.colour)
          .text(line.text, x, at + line.gap, {
            width: columnWidth,
            align,
            characterSpacing: line.spacing ?? 0,
          });
        at = doc.y;
      }
    };

    const textHeight = heightOf(establishment, textWidth);
    const titleHeight = heightOf(title, titleWidth);
    const height = Math.max(textHeight, titleHeight, logo?.height ?? 0);

    if (logo !== null) {
      doc.image(logo.bytes, left, top + (height - logo.height) / 2, {
        width: logo.width,
        height: logo.height,
      });
    }
    paint(establishment, textLeft, top + (height - textHeight) / 2, textWidth, 'left'); // prettier-ignore
    paint(title, titleLeft, top + (height - titleHeight) / 2, titleWidth, 'right'); // prettier-ignore

    const ruleY = top + height + mm(3);
    doc
      .moveTo(left, ruleY)
      .lineTo(left + width, ruleY)
      .lineWidth(1.5)
      .strokeColor(frame.accentColour)
      .stroke();

    cursor.y = ruleY + mm(5);
  }

  /** The size an image takes inside a box, keeping its proportions. */
  private fitted(
    image: { width: number; height: number },
    boxWidth: number,
    boxHeight: number,
  ): { width: number; height: number } {
    const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
    return { width: image.width * scale, height: image.height * scale };
  }

  // ── blocks ───────────────────────────────────────────────────────────────

  /**
   * A SIGNATURE NEVER STANDS ALONE ON A PAGE. The box is where the seal goes,
   * and a seal on an otherwise empty sheet vouches for nothing written on it:
   * the 117 printed the professional's data on page 1 and the box on page 2.
   *
   * So the closing group — a heading, the fields it introduces and the
   * signature, or just the fields and the signature — is measured as one, and
   * `ensure`d before its first block: it moves whole to the next page or not
   * at all. `null` when `index` does not start such a group.
   */
  private signedGroupHeight(
    doc: PDFKit.PDFDocument,
    blocks: readonly Block[],
    index: number,
    width: number,
  ): number | null {
    const [first, second, third] = blocks.slice(index, index + 3);
    if (first?.kind === 'fields' && second?.kind === 'signature') {
      return this.signedFieldsHeight(doc, first, width);
    }
    if (
      first?.kind === 'heading' &&
      second?.kind === 'fields' &&
      third?.kind === 'signature'
    ) {
      return HEADING_HEIGHT + this.signedFieldsHeight(doc, second, width);
    }
    return null;
  }

  /** The fields beside their seal (the template's row), as one height. */
  private signedFieldsHeight(
    doc: PDFKit.PDFDocument,
    fields: Extract<Block, { kind: 'fields' }>,
    width: number,
  ): number {
    const beside = width - mm(SIGNATURE_BOX_MM.width) - mm(SIGNATURE_GAP_MM);
    return Math.max(this.fieldsHeight(doc, fields, beside), SIGNATURE_HEIGHT);
  }

  /**
   * Paints `blocks[index]` and returns how many FOLLOWING blocks it consumed.
   *
   * Fields followed by a signature are one row of the template: the data on
   * the left, the box for the seal on the right, both standing on the same
   * line (`align-items: flex-end`). One is returned for the signature.
   */
  private paintBlockAt(
    doc: PDFKit.PDFDocument,
    blocks: readonly Block[],
    index: number,
    images: LayoutImages,
    left: number,
    width: number,
    cursor: Cursor,
    ensure: Ensure,
    accent: string,
    room: Room = UNBOUNDED,
  ): number {
    const block = blocks[index];
    const next = blocks[index + 1];
    if (block === undefined) return 0;
    if (block.kind === 'fields' && next?.kind === 'signature') {
      const height = this.signedFieldsHeight(doc, block, width);
      ensure(height);
      const top = cursor.y;
      const beside = width - mm(SIGNATURE_BOX_MM.width) - mm(SIGNATURE_GAP_MM);
      const fieldsHeight = this.fieldsHeight(doc, block, beside);
      const fields: Cursor = { y: top + height - fieldsHeight };
      this.paintBlock(doc, block, images, left, beside, fields, NEVER_BREAKS, accent); // prettier-ignore
      const seal: Cursor = { y: top + height - SIGNATURE_HEIGHT };
      this.paintBlock(doc, next, images, left, width, seal, NEVER_BREAKS, accent); // prettier-ignore
      cursor.y = top + height;
      return 1;
    }
    this.paintBlock(doc, block, images, left, width, cursor, ensure, accent, room); // prettier-ignore
    return 0;
  }

  /** The rows of a `fields` grid: entries placed left to right, by span. */
  private fieldRows(block: Extract<Block, { kind: 'fields' }>): FieldRow[] {
    const rows: FieldRow[] = [];
    let row: FieldRow = [];
    let used = 0;
    for (const entry of block.entries) {
      const span = Math.min(entry.span ?? 1, block.columns);
      if (used + span > block.columns) {
        rows.push(row);
        row = [];
        used = 0;
      }
      row.push({ entry, column: used, span });
      used += span;
      if (used === block.columns) {
        rows.push(row);
        row = [];
        used = 0;
      }
    }
    if (row.length > 0) rows.push(row);
    return rows;
  }

  /** The height of one entry of a `fields` grid in a cell `width` wide. */
  private entryHeight(
    doc: PDFKit.PDFDocument,
    entry: LabelledValue,
    width: number,
    inline: boolean,
  ): number {
    if (inline) {
      // Measured in bold, which is wider: the label is bold, and measured in
      // the regular face a «label: value» that wraps came out one line short —
      // the next entry was painted over its second line.
      return doc
        .font(SANS_BOLD)
        .fontSize(SIZE.body)
        .heightOfString(`${entry.label}: ${entry.value}`, { width, lineGap: LINE_GAP }); // prettier-ignore
    }
    const label = doc.font(SANS_BOLD).fontSize(SIZE.label).heightOfString(entry.label, { width }); // prettier-ignore
    const value = doc.font(SANS).fontSize(SIZE.body).heightOfString(entry.value, { width, lineGap: LINE_GAP }); // prettier-ignore
    return label + value + 0.5;
  }

  /** What `paintBlock` advances for a `fields` block, measured before painting. */
  private fieldsHeight(
    doc: PDFKit.PDFDocument,
    block: Extract<Block, { kind: 'fields' }>,
    width: number,
  ): number {
    const columnWidth = width / block.columns;
    const gap = block.inline === true ? mm(1) : mm(2.5);
    return this.fieldRows(block).reduce(
      (total, row) =>
        total +
        gap +
        Math.max(
          ...row.map(
            ({ entry, span }) =>
            this.entryHeight(doc, entry, span * columnWidth - mm(3), block.inline === true), // prettier-ignore
          ),
        ),
      0,
    );
  }

  /**
   * Paints one block of the layout. Each kind calls `ensure` with its height
   * first, so a block that does not fit starts a new page instead of running
   * into the reserved band.
   */
  private paintBlock(
    doc: PDFKit.PDFDocument,
    block: Block,
    images: LayoutImages,
    left: number,
    width: number,
    cursor: Cursor,
    ensure: Ensure,
    accent: string,
    room: Room = UNBOUNDED,
  ): void {
    switch (block.kind) {
      case 'spacer':
        cursor.y += mm(block.millimetres);
        return;

      case 'rule':
        ensure(mm(3));
        doc
          .moveTo(left, cursor.y)
          .lineTo(left + width, cursor.y)
          .lineWidth(0.75)
          .strokeColor(RULE_STRONG)
          .stroke();
        cursor.y += mm(3);
        return;

      case 'heading':
        // DOC-085, DOC-104. Section titles in the accent, as the template.
        ensure(HEADING_HEIGHT);
        doc
          .font(SERIF_BOLD)
          .fontSize(SIZE.heading)
          .fillColor(accent)
          .text(block.text, left, cursor.y, { width });
        cursor.y = doc.y + mm(1.5);
        return;

      case 'title':
        ensure(mm(8));
        doc
          .font(SERIF_BOLD)
          .fontSize(SIZE.title)
          .fillColor(accent)
          .text(block.text, left, cursor.y, { width, characterSpacing: 0.5 });
        cursor.y = doc.y + mm(1.5);
        return;

      case 'name':
        ensure(mm(7));
        doc
          .font(SERIF_BOLD)
          .fontSize(SIZE.boxName)
          .fillColor(INK)
          .text(block.text, left, cursor.y, { width });
        cursor.y = doc.y + mm(1.5);
        return;

      case 'caption':
        ensure(mm(5));
        doc
          .font(SANS_BOLD)
          .fontSize(SIZE.label)
          .fillColor(LABEL)
          .text(block.text, left, cursor.y, { width });
        cursor.y = doc.y + mm(1);
        return;

      case 'paragraph':
        ensure(mm(6));
        doc
          .font(block.emphasis === true ? SANS_BOLD : SANS)
          .fontSize(SIZE.body)
          .fillColor(INK)
          .text(block.text, left, cursor.y, { width, lineGap: LINE_GAP });
        cursor.y = doc.y + mm(2);
        return;

      case 'fields': {
        const columnWidth = width / block.columns;
        const inline = block.inline === true;
        const gap = inline ? mm(1) : mm(2.5);
        for (const row of this.fieldRows(block)) {
          // A row moves WHOLE to the next page: an indication split across
          // two sheets is one somebody reads half of.
          const rowHeight = Math.max(
            ...row.map(({ entry, span }) =>
              this.entryHeight(doc, entry, span * columnWidth - mm(3), inline),
            ),
          );
          ensure(rowHeight + mm(1));
          const rowTop = cursor.y;
          // Where the text actually ended: a measure is an estimate, and the
          // next row starts under the painted one, never over it.
          let rowBottom = rowTop + rowHeight;
          for (const { entry, column, span } of row) {
            const x = left + column * columnWidth;
            const cellWidth = span * columnWidth - mm(3);
            const colour = entry.alert === true ? ALERT : INK;
            if (inline) {
              doc
                .font(SANS_BOLD)
                .fontSize(SIZE.body)
                .fillColor(INK)
                .text(`${entry.label}: `, x, rowTop, {
                  width: cellWidth,
                  lineGap: LINE_GAP,
                  continued: true,
                })
                .font(entry.alert === true ? SANS_SEMIBOLD : SANS)
                .fillColor(colour)
                .text(entry.value);
              rowBottom = Math.max(rowBottom, doc.y);
              continue;
            }
            doc
              .font(SANS_BOLD)
              .fontSize(SIZE.label)
              .fillColor(LABEL)
              .text(entry.label, x, rowTop, { width: cellWidth });
            doc
              .font(entry.alert === true ? SANS_SEMIBOLD : SANS)
              .fontSize(SIZE.body)
              .fillColor(colour)
              .text(entry.value, x, doc.y + 0.5, {
                width: cellWidth,
                lineGap: LINE_GAP,
              });
            rowBottom = Math.max(rowBottom, doc.y);
          }
          cursor.y = rowBottom + gap;
        }
        return;
      }

      case 'strip':
        this.paintStrip(doc, block, left, width, cursor, ensure);
        return;

      case 'note':
        this.paintNote(doc, block, left, width, cursor, ensure);
        return;

      case 'table':
        this.paintTable(doc, block, left, width, cursor, ensure);
        return;

      case 'signature': {
        ensure(SIGNATURE_HEIGHT);
        // DOC-057, DOC-060. The template's box on the right: where a hand signs.
        const boxWidth = mm(SIGNATURE_BOX_MM.width);
        const boxHeight = mm(SIGNATURE_BOX_MM.height);
        const boxLeft = left + width - boxWidth;
        this.paintSealBox(doc, block, images, boxLeft, cursor.y, boxWidth, boxHeight); // prettier-ignore
        cursor.y = doc.y + mm(3);
        return;
      }

      case 'barcode': {
        ensure(mm(BARCODE_HEIGHT_MM + 8));
        this.paintBarcode(doc, block.value, left, cursor.y, width);
        cursor.y += mm(BARCODE_HEIGHT_MM) + mm(1);
        doc
          .font(SANS)
          .fontSize(SIZE.label)
          .fillColor(INK)
          .text(block.value, left, cursor.y, { width, align: 'center' });
        cursor.y = doc.y + mm(2);
        return;
      }

      case 'logo': {
        // DOC-059. No logo, nothing: the RIDE's issuer box simply starts higher.
        if (images.logo === null) return;
        ensure(mm(RIDE_LOGO_HEIGHT_MM) + mm(2.5));
        const size = this.fitted(images.logo, width, mm(RIDE_LOGO_HEIGHT_MM)); // prettier-ignore
        // Centred in its column both ways, as the author asked (01-10-2026).
        const x = left + (width - size.width) / 2;
        const y = cursor.y + (mm(RIDE_LOGO_HEIGHT_MM) - size.height) / 2;
        doc.image(images.logo.bytes, x, y, size);
        cursor.y += mm(RIDE_LOGO_HEIGHT_MM) + mm(2.5);
        return;
      }

      /**
       * A FRAMED BLOCK IS NOT SPLIT ACROSS PAGES, so it is measured first —
       * painted on a throwaway document with the same fonts and widths — and
       * moved to the next page whole when it does not fit. Without that, the
       * RIDE's totals ran over the footer as soon as the detail had a few
       * lines.
       */
      case 'box':
      case 'boxes':
      case 'section': {
        // DOC-071. Taller than a page, it is cut into pieces that each fit
        // —rows whole, each piece framed and titled— instead of spilling over
        // the footer and PDFKit opening a page per line.
        const pieces = this.piecesOf(block, images, width, accent, room);
        for (const { piece, height } of pieces) {
          ensure(height);
          const bottom = this.paintFramed(
            doc,
            piece,
            images,
            left,
            width,
            cursor.y,
            accent,
          );
          cursor.y = bottom + mm(BLOCK_GAP_MM);
        }
        return;
      }
    }
  }

  /** The seal, or the labelled empty box where it goes, with its caption. */
  private paintSealBox(
    doc: PDFKit.PDFDocument,
    block: { caption: string; image: Extract<Block, { kind: 'signature' }>['image'] }, // prettier-ignore
    images: LayoutImages,
    x: number,
    y: number,
    width: number,
    height: number,
    captionSize: number = SIZE.label,
  ): void {
    const chosen =
      block.image === 'seal'
        ? images.seal
        : block.image === 'signature'
          ? images.signature
          : null;

    if (chosen !== null) {
      doc.image(chosen.bytes, x, y, {
        fit: [width, height],
        align: 'center',
        valign: 'center',
      });
    } else {
      // DOC-060. A LABELLED EMPTY BOX, never a drawn seal. The system cannot
      // manufacture one, and art. 5.d.iii is textual: «no se aceptarán
      // rúbricas o trazos por firma». An empty box is a document missing a
      // seal; a squiggle would be a forged one.
      doc
        .rect(x, y, width, height)
        .lineWidth(0.75)
        .strokeColor(EMPTY_BOX)
        .dash(2, { space: 2 })
        .stroke()
        .undash();
    }

    doc
      .font(SANS)
      .fontSize(captionSize)
      .fillColor(LABEL)
      .text(block.caption, x, y + height + mm(1), { width, align: 'center' });
  }

  /** Paints a framed block from `top`; returns where it ends. */
  private paintFramed(
    doc: PDFKit.PDFDocument,
    block: Extract<Block, { kind: 'box' | 'boxes' | 'section' }>,
    images: LayoutImages,
    left: number,
    width: number,
    top: number,
    accent: string,
  ): number {
    switch (block.kind) {
      case 'box':
        return this.paintBox(doc, block, images, left, width, top, accent);
      case 'boxes':
        return this.paintColumns(doc, block, images, left, width, top, accent);
      case 'section':
        return this.paintSection(doc, block, images, left, width, top);
    }
  }

  /** How tall something is: painted once where nobody sees it. */
  private measure(paint: (scratch: PDFKit.PDFDocument) => number): number {
    const scratch = new PDFDocument({
      size: [mm(PAGE_WIDTH_MM), MEASURING_PAGE_HEIGHT],
      margin: 0,
      autoFirstPage: false,
    });
    for (const name of Object.keys(FONTS) as FontName[]) {
      scratch.registerFont(name, FONTS[name]);
    }
    scratch.addPage();
    // Never `end()`ed: ending subsets and embeds the four fonts of a file
    // nobody reads. The document is dropped and collected as it is.
    return paint(scratch);
  }

  /** How tall a framed block is, painted where nobody sees it. */
  private heightOfFramed(
    block: Extract<Block, { kind: 'box' | 'boxes' | 'section' }>,
    images: LayoutImages,
    width: number,
    accent: string,
  ): number {
    return this.measure((scratch) =>
      this.paintFramed(scratch, block, images, 0, width, 0, accent),
    );
  }

  /**
   * DOC-071. A framed block cut, if it has to be, into pieces that fit: the
   * first one in what is left of the page (when that is worth using), the
   * rest in a whole page. A section is cut by its rows —a table line by line,
   * under its header again—; a box by its blocks —a grid of fields row by
   * row—. The pieces after the first say «(continuación)».
   *
   * A SEAL CLOSES WHAT IT SITS BESIDE (DOC-101): a section keeps it on the last
   * piece, and every candidate is measured WITH it, since it narrows the rows
   * beside it; in a box the seal travels with the last row of the fields it
   * follows. Two columns are not cut: what the RIDE puts in them is short by
   * construction (its totals and payment).
   *
   * Each piece comes with its height, so it is measured once.
   */
  private piecesOf(
    block: Framed,
    images: LayoutImages,
    width: number,
    accent: string,
    room: Room,
  ): { piece: Framed; height: number }[] {
    const heightOf = (piece: Framed): number =>
      this.heightOfFramed(piece, images, width, accent) + mm(BLOCK_GAP_MM);
    const whole = heightOf(block);
    if (block.kind === 'boxes' || whole <= room.left()) {
      return [{ piece: block, height: whole }];
    }
    if (whole <= room.page) return [{ piece: block, height: whole }];

    // The rest of this page is used only when it holds a useful piece.
    const firstLimit = room.left() >= mm(40) ? room.left() : room.page;
    const limitOf = (index: number): number =>
      index === 0 ? firstLimit : room.page;
    const continued = (text: string, index: number): string =>
      index === 0 ? text : `${text} (continuación)`;

    /** Greedy: units in order, a new piece when the next does not fit. */
    const cut = <Unit>(
      units: readonly Unit[],
      make: (units: readonly Unit[], index: number) => Framed,
    ): { piece: Framed; height: number }[] => {
      const pieces: { piece: Framed; height: number }[] = [];
      let current: Unit[] = [];
      for (const unit of units) {
        if (current.length > 0) {
          const candidate = make([...current, unit], pieces.length);
          if (heightOf(candidate) > limitOf(pieces.length)) {
            const piece = make(current, pieces.length);
            pieces.push({ piece, height: heightOf(piece) });
            current = [];
          }
        }
        current.push(unit);
      }
      const piece = make(current, pieces.length);
      pieces.push({ piece, height: heightOf(piece) });
      return pieces;
    };

    if (block.kind === 'section') {
      // One unit per row and per line of a table; a table with no lines
      // keeps its header as a unit of its own.
      const units = block.rows.flatMap<SectionRow>((row) =>
        row.kind === 'table' && row.rows.length > 0
          ? row.rows.map((line) => ({ ...row, rows: [line] }))
          : [row],
      );
      const join = (rows: readonly SectionRow[]): SectionRow[] =>
        rows.reduce<SectionRow[]>((joined, row) => {
          const previous = joined.at(-1);
          const sameTable =
            row.kind === 'table' &&
            previous?.kind === 'table' &&
            previous.columns === row.columns;
          if (sameTable) {
            joined[joined.length - 1] = {
              ...previous,
              rows: [...previous.rows, ...row.rows],
            };
          } else {
            joined.push(row);
          }
          return joined;
        }, []);
      // Measured with the seal on every candidate: the last piece is the one
      // that carries it, and nobody knows which one is last until the end.
      const pieces = cut(units, (rows, index) => ({
        ...block,
        title: continued(block.title, index),
        rows: join(rows),
      }));
      return pieces.map(({ piece }, index) => {
        if (piece.kind !== 'section' || index === pieces.length - 1) {
          return { piece, height: heightOf(piece) };
        }
        const unsealed: Framed = { ...piece, signature: undefined };
        return { piece: unsealed, height: heightOf(unsealed) };
      });
    }

    // A box: its blocks, a grid of fields one row at a time, and a seal glued
    // to the row before it. A caption that heads the box heads every piece.
    const groups: Block[][] = [];
    for (const child of block.blocks) {
      if (child.kind === 'signature' && groups.length > 0) {
        groups[groups.length - 1]?.push(child);
        continue;
      }
      if (child.kind === 'fields') {
        for (const row of this.fieldRows(child)) {
          groups.push([{ ...child, entries: row.map(({ entry }) => entry) }]);
        }
        continue;
      }
      groups.push([child]);
    }
    const [lead] = block.blocks;
    const heading = lead?.kind === 'caption' ? lead.text : null;
    const body = heading === null ? groups : groups.slice(1);
    return cut(body, (chosen, index) => ({
      ...block,
      ...(block.title === undefined
        ? {}
        : { title: continued(block.title, index) }),
      blocks: [
        ...(heading === null
          ? []
          : [{ kind: 'caption' as const, text: continued(heading, index) }]),
        ...chosen.flat(),
      ],
    }));
  }

  /**
   * A framed group: rounded for the RIDE (DOC-106), with a grey title bar when
   * it has a title. Its content is painted first and the frame drawn round it,
   * down to `stretchTo` when the box has to finish level with its neighbour.
   */
  private paintBox(
    doc: PDFKit.PDFDocument,
    block: Extract<Block, { kind: 'box' }>,
    images: LayoutImages,
    left: number,
    width: number,
    top: number,
    accent: string,
    stretchTo = 0,
  ): number {
    const padX = mm(3);
    let y = top;
    if (block.title !== undefined) {
      const barHeight = SIZE.label + mm(2.6);
      doc.rect(left, top, width, barHeight).fillColor(BAR_FILL).fill();
      doc
        .font(SANS_BOLD)
        .fontSize(SIZE.label)
        .fillColor(INK)
        .text(block.title, left + mm(2.1), top + mm(1.3), {
          width: width - mm(4.2),
        });
      y = top + barHeight;
      doc
        .moveTo(left, y)
        .lineTo(left + width, y)
        .lineWidth(0.75)
        .strokeColor(RULE_STRONG)
        .stroke();
    }

    const inner: Cursor = { y: y + mm(2.4) };
    for (let index = 0; index < block.blocks.length; index += 1) {
      index += this.paintBlockAt(doc, block.blocks, index, images, left + padX, width - 2 * padX, inner, NEVER_BREAKS, accent); // prettier-ignore
    }
    // The blocks leave their own gap under them; the frame closes just below.
    const bottom = Math.max(inner.y, stretchTo);

    const frame =
      block.rounded === true
        ? doc.roundedRect(left, top, width, bottom - top, mm(BOX_RADIUS_MM))
        : doc.rect(left, top, width, bottom - top);
    frame
      .lineWidth(0.75)
      .strokeColor(block.light === true ? RULE_STRONG : INK)
      .stroke();
    return bottom;
  }

  /**
   * DOC-076, DOC-106. Two columns from the same top. A column that ends in a
   * box has it stretched to the taller column's bottom, so the issuer's box
   * and the voucher's finish level, as on the approved page.
   */
  private paintColumns(
    doc: PDFKit.PDFDocument,
    block: Extract<Block, { kind: 'boxes' }>,
    images: LayoutImages,
    left: number,
    width: number,
    top: number,
    accent: string,
  ): number {
    const gap = mm(4);
    const leftWidth = (width - gap) * (block.leftShare ?? 0.5);
    const rightWidth = width - gap - leftWidth;

    const paintColumn = (
      target: PDFKit.PDFDocument,
      blocks: readonly Block[],
      x: number,
      columnWidth: number,
      stretchTo: number,
    ): number => {
      const inner: Cursor = { y: top };
      let bottom = top;
      for (let index = 0; index < blocks.length; index += 1) {
        const child = blocks[index];
        if (child?.kind === 'box') {
          const last = index === blocks.length - 1;
          bottom = this.paintBox(target, child, images, x, columnWidth, inner.y, accent, last ? stretchTo : 0); // prettier-ignore
          inner.y = bottom + mm(BLOCK_GAP_MM);
          continue;
        }
        index += this.paintBlockAt(target, blocks, index, images, x, columnWidth, inner, NEVER_BREAKS, accent); // prettier-ignore
        bottom = inner.y;
      }
      return bottom;
    };

    const natural = (blocks: readonly Block[], columnWidth: number): number =>
      this.measure((scratch) =>
        paintColumn(scratch, blocks, 0, columnWidth, 0),
      );
    const bottom = Math.max(
      natural(block.left, leftWidth),
      natural(block.right, rightWidth),
    );

    paintColumn(doc, block.left, left, leftWidth, bottom);
    paintColumn(doc, block.right, left + leftWidth + gap, rightWidth, bottom);
    return bottom;
  }

  /**
   * DOC-105. One block of the 117: a framed box, a grey title bar, and its
   * data in cells divided by fine rules; the seal, when it has one, inside it
   * on the right. Titles in capitals, as the form prints them.
   */
  private paintSection(
    doc: PDFKit.PDFDocument,
    block: Extract<Block, { kind: 'section' }>,
    images: LayoutImages,
    left: number,
    width: number,
    top: number,
  ): number {
    const padX = mm(2.1);
    const padY = mm(1.3);
    const signatureWidth =
      block.signature === undefined ? 0 : mm(SECTION_SIGNATURE_MM.column);
    const rowsWidth = width - signatureWidth;

    const barHeight = SIZE.label + 2 * mm(1.1);
    doc.rect(left, top, width, barHeight).fillColor(BAR_FILL).fill();
    doc
      .font(SANS_BOLD)
      .fontSize(SIZE.label)
      .fillColor(INK)
      .text(block.title.toUpperCase(), left + padX, top + mm(1.1), {
        width: width - 2 * padX,
        characterSpacing: 0.3,
      });
    let y = top + barHeight;
    const bodyTop = y;

    const hairline = (x1: number, y1: number, x2: number, y2: number): void => {
      doc.moveTo(x1, y1).lineTo(x2, y2).lineWidth(0.5).strokeColor(RULE_STRONG).stroke(); // prettier-ignore
    };

    block.rows.forEach((row, index) => {
      if (index > 0) hairline(left, y, left + rowsWidth, y);
      switch (row.kind) {
        case 'cells': {
          const total = row.cells.reduce((sum, cell) => sum + cell.width, 0);
          const widths = row.cells.map((cell) => (cell.width / total) * rowsWidth); // prettier-ignore
          const heights = row.cells.map((cell, at) => {
            const inner = (widths[at] ?? 0) - 2 * padX;
            return (
              doc.font(SANS_BOLD).fontSize(SIZE.cell).heightOfString(cell.label, { width: inner }) + // prettier-ignore
              doc.font(cell.strong === true ? SANS_BOLD : SANS).fontSize(SIZE.body).heightOfString(cell.value, { width: inner }) // prettier-ignore
            );
          });
          const height = Math.max(...heights) + 2 * padY;
          let x = left;
          row.cells.forEach((cell, at) => {
            const cellWidth = widths[at] ?? 0;
            doc
              .font(SANS_BOLD)
              .fontSize(SIZE.cell)
              .fillColor(LABEL)
              .text(cell.label, x + padX, y + padY, { width: cellWidth - 2 * padX }); // prettier-ignore
            doc
              .font(cell.strong === true ? SANS_BOLD : SANS)
              .fontSize(SIZE.body)
              .fillColor(cell.alert === true ? ALERT : INK)
              .text(cell.value, x + padX, doc.y, { width: cellWidth - 2 * padX }); // prettier-ignore
            x += cellWidth;
            if (at < row.cells.length - 1) hairline(x, y, x, y + height);
          });
          y += height;
          return;
        }
        case 'text': {
          doc
            .font(SANS)
            .fontSize(SIZE.label + 0.75)
            .fillColor(INK)
            .text(row.text, left + padX, y + padY, { width: rowsWidth - 2 * padX }); // prettier-ignore
          y = doc.y + padY;
          return;
        }
        case 'table': {
          const widths = row.columns.map((column) => column.width * rowsWidth);
          const cells = (
            texts: readonly string[],
            font: FontName,
            size: number,
            colour: string,
          ): number => {
            let x = left;
            let bottom = y;
            texts.forEach((text, at) => {
              const column = row.columns[at];
              doc
                .font(font)
                .fontSize(size)
                .fillColor(colour)
                .text(text, x + padX, y + padY, {
                  width: (widths[at] ?? 0) - 2 * padX,
                  align: column?.align === 'right' ? 'right' : column?.align === 'centre' ? 'center' : 'left', // prettier-ignore
                });
              bottom = Math.max(bottom, doc.y);
              x += widths[at] ?? 0;
            });
            return bottom + padY;
          };
          y = cells(row.columns.map((column) => column.header), SANS_BOLD, SIZE.cell, LABEL); // prettier-ignore
          hairline(left, y, left + rowsWidth, y);
          for (const values of row.rows) {
            y = cells(values, SANS, SIZE.body, INK);
          }
          return;
        }
      }
    });

    let bottom = y;
    if (block.signature !== undefined) {
      const x = left + rowsWidth;
      const boxHeight = mm(SECTION_SIGNATURE_MM.height);
      this.paintSealBox(doc, block.signature, images, x + mm(2.1), bodyTop + mm(1.6), signatureWidth - mm(4.2), boxHeight, SIZE.cell); // prettier-ignore
      bottom = Math.max(bottom, doc.y + mm(1.6));
      hairline(x, bodyTop, x, bottom);
    }

    doc
      .moveTo(left, bodyTop)
      .lineTo(left + width, bodyTop)
      .lineWidth(0.75)
      .strokeColor(INK)
      .stroke();
    doc.rect(left, top, width, bottom - top).lineWidth(0.75).strokeColor(INK).stroke(); // prettier-ignore
    return bottom;
  }

  /**
   * DOC-075. An informative note on the light grey band, small and in a
   * softer ink: read by whoever holds the paper, not part of its data.
   */
  private paintNote(
    doc: PDFKit.PDFDocument,
    block: Extract<Block, { kind: 'note' }>,
    left: number,
    width: number,
    cursor: Cursor,
    ensure: Ensure,
  ): void {
    const padX = mm(2.6);
    const padY = mm(2.1);
    const inner = width - 2 * padX;
    const lineOf = (line: { label?: string; text: string }): string =>
      `${line.label ?? ''}${line.text}`;
    // Measured in bold, the wider face: a label that wraps cannot run short.
    const height =
      block.lines.reduce(
        (total, line) =>
          total + 1 + doc.font(SANS_BOLD).fontSize(SIZE.label).heightOfString(lineOf(line), { width: inner }), // prettier-ignore
        0,
      ) +
      2 * padY;

    ensure(height + mm(3));
    const top = cursor.y;
    doc
      .roundedRect(left, top, width, height, mm(STRIP_RADIUS_MM))
      .fillColor(STRIP_FILL)
      .fill();
    let y = top + padY;
    for (const line of block.lines) {
      doc.fontSize(SIZE.label).fillColor(NOTE_INK);
      if (line.label !== undefined) {
        doc
          .font(SANS_BOLD)
          .text(line.label, left + padX, y, { width: inner, continued: true })
          .font(SANS)
          .text(line.text);
      } else {
        doc.font(SANS).text(line.text, left + padX, y, { width: inner });
      }
      y = doc.y + 1;
    }
    cursor.y = Math.max(top + height, y + padY) + mm(3);
  }

  /**
   * DOC-104. The general data on one grey band, in one row: labels in
   * spaced capitals, the value under each.
   */
  private paintStrip(
    doc: PDFKit.PDFDocument,
    block: Extract<Block, { kind: 'strip' }>,
    left: number,
    width: number,
    cursor: Cursor,
    ensure: Ensure,
  ): void {
    const padX = mm(3.2);
    const padY = mm(2.6);
    const gap = mm(3.2);
    if (block.entries.length === 0) return;
    const count = block.entries.length;
    const columnWidth = (width - 2 * padX - (count - 1) * gap) / count;
    const labelOptions = { width: columnWidth, characterSpacing: 0.45 };

    const height =
      Math.max(
        ...block.entries.map(
          (entry) =>
            doc.font(SANS_BOLD).fontSize(SIZE.label).heightOfString(entry.label.toUpperCase(), labelOptions) + // prettier-ignore
            doc
              .font(SANS)
              .fontSize(SIZE.body)
              .heightOfString(entry.value, { width: columnWidth }) + // prettier-ignore
            1,
        ),
      ) +
      2 * padY;

    ensure(height + mm(4));
    const top = cursor.y;
    doc
      .roundedRect(left, top, width, height, mm(STRIP_RADIUS_MM))
      .fillColor(STRIP_FILL)
      .fill();
    block.entries.forEach((entry, index) => {
      const x = left + padX + index * (columnWidth + gap);
      doc
        .font(SANS_BOLD)
        .fontSize(SIZE.label)
        .fillColor(LABEL)
        .text(entry.label.toUpperCase(), x, top + padY, labelOptions);
      doc
        .font(SANS)
        .fontSize(SIZE.body)
        .fillColor(INK)
        .text(entry.value, x, doc.y + 1, { width: columnWidth });
    });
    cursor.y = top + height + mm(4);
  }

  /**
   * DOC-085. A table whose column widths are fractions of the text width, with
   * a header row and 1 px rules. Rows are measured before painting and moved
   * to the next page whole.
   *
   * DOC-106. FRAMED, it is the RIDE's: an outer border, a grey header and —
   * `grid`— a rule between every cell. A framed table that turns a page
   * repeats its header there, and each page's part of it is closed.
   */
  private paintTable(
    doc: PDFKit.PDFDocument,
    block: Extract<Block, { kind: 'table' }>,
    left: number,
    width: number,
    cursor: Cursor,
    ensure: Ensure,
  ): void {
    const { columns, rows } = block;
    const dense = block.dense === true;
    const framed = block.framed;
    const widths = columns.map((column) => column.width * width);
    /** Space above and below a row's text, and the least a row measures. */
    const pad = framed !== undefined ? (dense ? mm(1) : mm(1.3)) : dense ? mm(0.6) : mm(1.5); // prettier-ignore
    const minimumRow = dense || framed !== undefined ? 0 : mm(4.5);
    /** Framed cells keep their text off the rules, on both sides. */
    const inset = framed === undefined ? 0 : mm(1.6);
    const textWidth = (index: number): number =>
      framed === undefined ? widthAt(index) - mm(1.5) : widthAt(index) - 2 * inset; // prettier-ignore
    const align = (
      column: TableColumn | undefined,
    ): 'left' | 'right' | 'center' =>
      column?.align === 'right'
        ? 'right'
        : column?.align === 'centre'
          ? 'center'
          : 'left';

    /** `noUncheckedIndexedAccess` is on, and the two arrays are the same length. */
    const widthAt = (index: number): number => widths[index] ?? 0;

    const rule = (y: number, colour: string, lineWidth = 0.75): void => {
      doc
        .moveTo(left, y)
        .lineTo(left + width, y)
        .lineWidth(lineWidth)
        .strokeColor(colour)
        .stroke();
    };

    /** The sides of a framed row and, in a grid, the rules between its cells. */
    const sides = (top: number, bottom: number): void => {
      if (framed === undefined) return;
      if (framed === 'grid') {
        let x = left;
        widths.slice(0, -1).forEach((each) => {
          x += each;
          doc.moveTo(x, top).lineTo(x, bottom).lineWidth(0.5).strokeColor(RULE_STRONG).stroke(); // prettier-ignore
        });
      }
      doc.moveTo(left, top).lineTo(left, bottom).moveTo(left + width, top).lineTo(left + width, bottom) // prettier-ignore
        .lineWidth(0.75).strokeColor(INK).stroke(); // prettier-ignore
    };

    const paintRow = (
      cells: readonly string[],
      font: FontName,
      size: number,
      colour: string,
      fill: string | null,
      height: number,
      inner = pad,
    ): void => {
      const top = cursor.y;
      if (fill !== null)
        doc.rect(left, top, width, height).fillColor(fill).fill();
      let x = left;
      doc.font(font).fontSize(size).fillColor(colour);
      cells.forEach((cell, index) => {
        doc.text(cell, x + inset, top + (framed === undefined ? 0 : inner), {
          width: textWidth(index),
          align: align(columns[index]),
        });
        x += widthAt(index);
      });
      sides(top, top + height);
    };

    const headerHeight = (): number =>
      Math.max(
        ...columns.map(
          (column, index) =>
          doc.font(SANS_BOLD).fontSize(SIZE.label).heightOfString(column.header, { width: textWidth(index) }), // prettier-ignore
        ),
      ) +
      2 * pad;

    const paintHeaderRow = (): void => {
      if (framed !== undefined) {
        rule(cursor.y, INK);
        if (block.headless === true) return;
        const height = headerHeight();
        paintRow(columns.map((c) => c.header), SANS_BOLD, SIZE.label, INK, BAR_FILL, height); // prettier-ignore
        cursor.y += height;
        rule(cursor.y, RULE_STRONG, 0.5);
        return;
      }
      rule(cursor.y, INK);
      cursor.y += mm(1.5);
      let x = left;
      doc.font(SANS_BOLD).fontSize(SIZE.label).fillColor(LABEL);
      columns.forEach((column, index) => {
        doc.text(column.header, x, cursor.y, {
          width: widthAt(index) - mm(1.5),
          align: align(column),
        });
        x += widthAt(index);
      });
      cursor.y += mm(4.5);
      rule(cursor.y, RULE_STRONG);
      cursor.y += mm(1.5);
    };

    ensure(mm(14));
    paintHeaderRow();

    rows.forEach((row, rowIndex) => {
      const emphasised = block.emphasiseLast === true && rowIndex === rows.length - 1; // prettier-ignore
      const font = emphasised ? SANS_BOLD : SANS;
      // Measure first: a row that does not fit moves whole, so no line of a
      // prescription is ever split across two pages.
      const heights = row.map(
        (cell, index) =>
        doc.font(font).fontSize(SIZE.body).heightOfString(cell, { width: textWidth(index) }), // prettier-ignore
      );
      const textHeight = Math.max(...heights, minimumRow);

      if (framed !== undefined) {
        // VALOR TOTAL stands taller, its text centred in the extra room.
        const inner = emphasised ? pad * 1.5 : pad;
        const height = textHeight + 2 * inner;
        // A row that does not fit moves WHOLE, and the table goes on under
        // its header again: a page of figures with no column names is a page
        // somebody reads wrong.
        const leaving = { page: lastPage(doc), y: cursor.y };
        if (ensure(height)) {
          // The part left on the previous page is closed there in ink, as
          // the template's border; this page's part opens under its header.
          const fresh = lastPage(doc);
          doc.switchToPage(leaving.page);
          rule(leaving.y, INK);
          doc.switchToPage(fresh);
          paintHeaderRow();
        }
        paintRow(
          row,
          font,
          SIZE.body,
          INK,
          emphasised ? BAR_FILL : null,
          height,
          inner,
        );
        cursor.y += height;
        const last = rowIndex === rows.length - 1;
        if (!last) rule(cursor.y, framed === 'grid' ? RULE_STRONG : RULE_LIGHT, 0.5); // prettier-ignore
        return;
      }

      // A row that does not fit moves WHOLE to the next page: half a
      // prescription line across a page break is a line somebody misreads.
      ensure(textHeight + 2 * pad);
      paintRow(row, font, SIZE.body, INK, null, textHeight);
      cursor.y += textHeight + pad;
      rule(cursor.y, RULE_LIGHT);
      cursor.y += pad;
    });

    if (framed !== undefined) rule(cursor.y, INK);
    cursor.y += mm(framed === undefined ? 2 : BLOCK_GAP_MM);
  }

  // ── tear-off band and footers ────────────────────────────────────────────

  /**
   * DOC-073. The detachable band, at a FIXED distance from the bottom edge.
   *
   * Art. 5.e of the Resolución ACESS-2023-0030 admits that the indications go
   * on a detachable block, which makes this page geometry rather than styling.
   * The band carries the patient's name and the date again: a detached strip
   * with no name on it is a loose piece of paper that does not say whose it is.
   */
  private paintTearOff(
    doc: PDFKit.PDFDocument,
    layout: DocumentLayout,
    images: LayoutImages,
    left: number,
    width: number,
    /** Opens a page with its header; returns where its body starts and stops. */
    nextPage: () => { top: number; bottom: number },
  ): void {
    const band = layout.tearOff;
    if (band === null) return;

    const cutY = doc.page.height - mm(TEAR_OFF_HEIGHT_MM);
    const accent = layout.frame.accentColour;

    // The caption sits IN the cut line, as on the approved page: the line
    // says where to cut and what the strip is, and takes no room of its own.
    doc.font(SANS_BOLD).fontSize(SIZE.label);
    const captionWidth = doc.widthOfString(band.caption);
    const centre = left + width / 2;
    doc
      .moveTo(left, cutY)
      .lineTo(centre - captionWidth / 2 - mm(2), cutY)
      .moveTo(centre + captionWidth / 2 + mm(2), cutY)
      .lineTo(left + width, cutY)
      .lineWidth(0.75)
      .strokeColor(LABEL)
      .dash(4, { space: 3 })
      .stroke()
      .undash();
    doc.fillColor(LABEL).text(band.caption, left, cutY - SIZE.label / 2 - 1, {
      width,
      align: 'center',
      lineBreak: false,
    });

    const cursor: Cursor = { y: cutY + mm(4) };
    const identification: Block = {
      kind: 'fields',
      columns: 2,
      entries: band.identification,
    };

    /**
     * THE SEAL SITS BESIDE THE INDICATIONS, NOT UNDER THEM, AND IT GOES FIRST.
     * Art. 5.e.iv asks for it in the band; painted before the text it stays on
     * this page whatever the text does next.
     */
    const seals = band.blocks.filter((block) => block.kind === 'signature');
    const text = band.blocks.filter((block) => block.kind !== 'signature');
    const textWidth = seals.length === 0 ? width : width - mm(60);
    const sealCursor: Cursor = { y: cursor.y };
    for (const block of seals) {
      this.paintBlock(doc, block, images, left, width, sealCursor, NEVER_BREAKS, accent); // prettier-ignore
    }

    /**
     * DOC-073. THE BAND NEVER RUNS INTO THE PAGE EDGE. What does not fit goes
     * on to a new page — with the establishment's header (DOC-071) and the
     * patient's name and date again, because a detached strip that does not
     * say whose it is is a loose piece of paper. Overflowing was printing the
     * last indications over the footer, and then on a page with nobody's name.
     */
    let bottom = doc.page.height - mm(PAGE_MARGIN_MM);
    const ensure: Ensure = (height) => {
      if (cursor.y + height <= bottom) return false;
      const page = nextPage();
      cursor.y = page.top;
      bottom = page.bottom;
      doc
        .font(SANS_BOLD)
        .fontSize(SIZE.label)
        .fillColor(LABEL)
        .text(`${band.caption} (continuación)`, left, cursor.y, {
          width,
          align: 'center',
        });
      cursor.y = doc.y + mm(1.5);
      this.paintBlock(doc, identification, images, left, width, cursor, NEVER_BREAKS, accent); // prettier-ignore
      return true;
    };

    this.paintBlock(doc, identification, images, left, textWidth, cursor, ensure, accent); // prettier-ignore
    for (const block of text) {
      this.paintBlock(doc, block, images, left, textWidth, cursor, ensure, accent); // prettier-ignore
    }
  }

  /**
   * DOC-071, DOC-083. On EVERY page, once the total is known: the verification
   * code and where to check it, the class's note, «Página x de y» and the QR.
   */
  private paintFooters(
    doc: PDFKit.PDFDocument,
    layout: DocumentLayout,
    left: number,
    width: number,
  ): void {
    const { footer } = layout.frame;
    const qrSide = mm(QR_SIZE_MM);
    const qrWidth = footer.verification === null ? 0 : qrSide + mm(3);
    const pageLabelWidth = mm(24);
    const textWidth = width - qrWidth - pageLabelWidth;

    const lines = [
      ...(footer.verification === null
        ? []
        : [
            `Documento electrónico generado por el sistema · código de verificación ${footer.verification.code}`,
            `Verifique en ${footer.verification.url}`,
          ]),
      ...footer.notes,
      // The clinic's free footer, on ONE line: it may hold line breaks, and a
      // footer that wraps runs off the page and opens blank ones.
      ...(footer.text === null || footer.text.trim() === ''
        ? []
        : [footer.text.trim().replace(/\s*\n\s*/g, ' · ')]),
    ];
    // At most what fits above the bottom edge; the rest is not printed.
    const maxLines = Math.floor((mm(FOOTER_HEIGHT_MM) - mm(2)) / (SIZE.label + 2)); // prettier-ignore

    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      doc.switchToPage(range.start + index);
      // The footer sits INSIDE the bottom margin, and PDFKit opens a new page
      // for any text that crosses it. Lifting the margin while the footer is
      // painted is what keeps «Página 1 de 1» from creating page 2.
      const margins = doc.page.margins;
      doc.page.margins = { ...margins, bottom: 0 };
      const top = footerTopOf(doc, layout);
      const bottom = top + mm(FOOTER_HEIGHT_MM);

      doc
        .moveTo(left, top)
        .lineTo(left + width, top)
        .lineWidth(0.75)
        .strokeColor(RULE_STRONG)
        .stroke();

      let y = top + mm(2);
      doc.font(SANS).fontSize(SIZE.label).fillColor(LABEL);
      for (const line of lines.slice(0, maxLines)) {
        // ONE row per line, cut with an ellipsis: `lineBreak: false` alone
        // still wraps at `width`, and a wrapped footer opened blank pages.
        doc.text(line, left, y, {
          width: textWidth,
          height: SIZE.label + 1,
          ellipsis: true,
          lineBreak: false,
        });
        y += SIZE.label + 2;
      }

      doc.text(
        `Página ${index + 1} de ${range.count}`,
        left + textWidth,
        bottom - SIZE.label - 1,
        { width: pageLabelWidth, align: 'right', lineBreak: false },
      );

      if (footer.verification !== null) {
        this.paintQr(
          doc,
          footer.verification.url,
          left + width - qrSide,
          bottom - qrSide,
          qrSide,
        );
      }
      doc.page.margins = margins;
    }
    // DOC-071. The footer may not change the page count it just printed.
    if (doc.bufferedPageRange().count !== range.count) {
      throw new Error('The footer opened a page of its own');
    }
    // Without this, `end()` flushes while the cursor sits on the first page and
    // PDFKit appends nothing further — harmless today, and a trap for whoever
    // adds a final block later.
    doc.flushPages();
  }

  /**
   * DOC-078. Code 128 as VECTOR bars, never as an image — the same reason as
   * the QR: an image is how transparency gets into a PDF/A-1b (DOC-023).
   *
   * bwip-js (ADR-004) computes the symbol — start code, the switch to subset C
   * for the digit pairs, the check character, stop — and hands back the
   * widths of bars and spaces (`sbs`, bar first). This only draws them, with
   * the quiet zone of ten modules a reader needs on each side, and never
   * narrower than 0.19 mm a module (ISO/IEC 15417's practical minimum for
   * office printers): a key that does not fit is drawn at the minimum and
   * left to overflow its box rather than shrunk into something unreadable.
   */
  private paintBarcode(
    doc: PDFKit.PDFDocument,
    value: string,
    x: number,
    y: number,
    width: number,
  ): void {
    const widths = barsOf(value);
    const modules = widths.reduce((total, each) => total + each, 0) + 20;
    const module = Math.max(width / modules, mm(0.19));
    const symbolWidth = modules * module;
    let at = x + (width - symbolWidth) / 2 + 10 * module;
    widths.forEach((each, index) => {
      if (index % 2 === 0)
        doc.rect(at, y, each * module, mm(BARCODE_HEIGHT_MM));
      at += each * module;
    });
    doc.fillColor(INK).fill();
  }

  /**
   * DOC-083. The QR as VECTOR rectangles, never as an image.
   *
   * An image is the way transparency gets into a PDF/A-1b (DOC-023), and a
   * raster QR blurs when the paper is photocopied; filled squares in the page
   * stream do neither. `qrcode` only computes the matrix — no canvas, no file.
   * Error correction M (15 %): a smudged corner of a receta still reads.
   */
  private paintQr(
    doc: PDFKit.PDFDocument,
    text: string,
    x: number,
    y: number,
    side: number,
  ): void {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const cell = side / modules.size;
    for (let row = 0; row < modules.size; row += 1) {
      for (let column = 0; column < modules.size; column += 1) {
        if (modules.get(row, column)) {
          // A hair wider than the cell so adjacent squares never show a seam.
          doc.rect(x + column * cell, y + row * cell, cell + 0.05, cell + 0.05);
        }
      }
    }
    doc.fillColor(INK).fill();
  }
}

/**
 * DOC-078. The widths of the Code 128 symbol of `value`, bar first, in modules.
 * Exported for the test that reads the symbol back.
 */
export function barsOf(value: string): number[] {
  const [symbol] = bwipjs.raw({ bcid: 'code128', text: value, parse: false });
  return [...((symbol as { sbs?: number[] } | undefined)?.sbs ?? [])];
}

/**
 * The page the body is being painted on: always the last one, since the body
 * only ever adds pages at the end (the footers switch back later).
 */
function lastPage(doc: PDFKit.PDFDocument): number {
  const range = doc.bufferedPageRange();
  return range.start + range.count - 1;
}

/**
 * DOC-073, DOC-083. Where the footer starts. On a receta it sits ABOVE the cut
 * line, so the part the pharmacy keeps carries the QR, the verification URL
 * and «Página x de y»; the strip the patient takes is only theirs.
 */
function footerTopOf(doc: PDFKit.PDFDocument, layout: DocumentLayout): number {
  return layout.tearOff === null
    ? doc.page.height - mm(PAGE_MARGIN_MM) - mm(FOOTER_HEIGHT_MM)
    : doc.page.height - mm(TEAR_OFF_HEIGHT_MM) - mm(2) - mm(FOOTER_HEIGHT_MM);
}
