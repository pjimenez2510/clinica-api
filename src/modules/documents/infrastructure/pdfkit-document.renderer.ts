import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import QRCode from 'qrcode';

import { DocumentRenderFailedError } from '../domain/document.errors';
import {
  PAGE_MARGIN_MM,
  TEAR_OFF_HEIGHT_MM,
  millimetresToPoints,
} from '../domain/page-layout';
import { FONTS, type FontName } from './embedded-fonts';
import type {
  DocumentMetadata,
  DocumentRenderer,
  LayoutImages,
} from '../domain/document-rendering.port';
import type { Block, DocumentLayout, TableColumn } from '../domain/page-layout';

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
  heading: 10.5,
  reference: 9.75,
  body: 9,
  label: 7.5,
} as const;
const LINE_GAP = 1.5;

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
/** DOC-076. The RIDE's logo, above its boxes: the template's 84 px high. */
const RIDE_LOGO_BOX_MM = { width: 60, height: 22 } as const;
/** DOC-080. The right-hand column: title, reference, CONFIDENCIAL. */
const TITLE_COLUMN_MM = 62;

/**
 * The vertical position on the current page, shared by reference between the
 * painting steps so each one continues where the previous stopped.
 */
interface Cursor {
  y: number;
}

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

    const startPage = (): void => {
      cursor.y = mm(PAGE_MARGIN_MM);
      this.paintWatermark(doc, layout.frame.watermark);
      this.paintHeader(doc, layout, images, left, contentWidth, cursor);
    };

    const ensure = (height: number): void => {
      if (cursor.y + height <= bottomLimit) return;
      doc.addPage();
      startPage();
    };

    startPage();

    for (const block of layout.blocks) {
      this.paintBlock(doc, block, images, left, contentWidth, cursor, ensure);
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

    if (header === null) {
      // DOC-076, DOC-084. The RIDE has its own head (Anexo 2): only its logo
      // is the frame's, above the boxes its composer draws.
      if (frame.hasLogo && images.logo !== null) {
        doc.image(images.logo.bytes, left, cursor.y, {
          fit: [mm(RIDE_LOGO_BOX_MM.width), mm(RIDE_LOGO_BOX_MM.height)],
        });
        cursor.y += mm(RIDE_LOGO_BOX_MM.height) + mm(4);
      }
      return;
    }

    const top = cursor.y;
    const titleWidth = mm(TITLE_COLUMN_MM);
    const titleLeft = left + width - titleWidth;
    let textLeft = left;
    let bottom = top;

    // DOC-059. No logo, nothing drawn: not an empty box on the paper.
    if (header.hasLogo && images.logo !== null) {
      doc.image(images.logo.bytes, left, top, {
        fit: [mm(LOGO_BOX_MM.width), mm(LOGO_BOX_MM.height)],
      });
      textLeft = left + mm(LOGO_BOX_MM.width) + mm(4);
      bottom = top + mm(LOGO_BOX_MM.height);
    }
    const textWidth = titleLeft - mm(4) - textLeft;

    doc
      .font(SERIF_BOLD)
      .fontSize(SIZE.name)
      .fillColor(INK)
      .text(header.establishmentName, textLeft, top, { width: textWidth });

    // DOC-081. Only with several sites; the composer of the frame decided it.
    if (header.siteLine !== null) {
      doc
        .font(SANS_SEMIBOLD)
        .fontSize(SIZE.body)
        .fillColor(frame.accentColour)
        .text(header.siteLine, textLeft, doc.y + 1, { width: textWidth });
    }

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
    for (const line of [contact, registry]) {
      const text = line
        .filter((entry): entry is string => entry !== null && entry !== '')
        .join(' · ');
      if (text === '') continue;
      doc
        .font(SANS)
        .fontSize(SIZE.body)
        .fillColor(LABEL)
        .text(text, textLeft, doc.y + 1, { width: textWidth });
    }
    bottom = Math.max(bottom, doc.y);

    // ── the right-hand column: what this paper is ──
    doc
      .font(SERIF_BOLD)
      .fontSize(SIZE.title)
      .fillColor(frame.accentColour)
      .text(frame.title, titleLeft, top, {
        width: titleWidth,
        align: 'right',
        characterSpacing: 0.4,
      });
    if (frame.reference !== null) {
      doc
        .font(SANS_BOLD)
        .fontSize(SIZE.reference)
        .fillColor(INK)
        .text(frame.reference, titleLeft, doc.y + 2, {
          width: titleWidth,
          align: 'right',
        });
    }
    // DOC-082. A.M. 5216-A art. 33: health information is confidential, and
    // the legend says so on exactly the papers that carry a diagnosis.
    if (frame.confidential) {
      doc
        .font(SANS_BOLD)
        .fontSize(SIZE.label)
        .fillColor(ALERT)
        .text('CONFIDENCIAL', titleLeft, doc.y + 2, {
          width: titleWidth,
          align: 'right',
          characterSpacing: 0.6,
        });
    }
    bottom = Math.max(bottom, doc.y);

    const ruleY = bottom + mm(3);
    doc
      .moveTo(left, ruleY)
      .lineTo(left + width, ruleY)
      .lineWidth(1.5)
      .strokeColor(frame.accentColour)
      .stroke();

    cursor.y = ruleY + mm(5);
  }

  // ── blocks ───────────────────────────────────────────────────────────────

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
    ensure: (height: number) => void,
    accent = INK,
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
        ensure(mm(9));
        doc
          .font(SERIF_BOLD)
          .fontSize(SIZE.heading)
          .fillColor(accent)
          .text(block.text, left, cursor.y, { width });
        cursor.y = doc.y + mm(1.5);
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
        let column = 0;
        let rowTop = cursor.y;
        let rowBottom = cursor.y;

        /** The height a row of entries will take, measured before painting. */
        const rowHeight = (from: number): number =>
          Math.max(
            ...block.entries.slice(from, from + block.columns).map((entry) => {
              const inner = columnWidth - mm(3);
              const label = doc.font(SANS_BOLD).fontSize(SIZE.label).heightOfString(entry.label, { width: inner }); // prettier-ignore
              const value = doc.font(SANS).fontSize(SIZE.body).heightOfString(entry.value, { width: inner, lineGap: LINE_GAP }); // prettier-ignore
              return label + value + 0.5;
            }),
          );

        for (const [index, entry] of block.entries.entries()) {
          if (column === 0) {
            // A row moves WHOLE to the next page: an indication split across
            // two sheets is one somebody reads half of.
            ensure(rowHeight(index) + mm(1));
            rowTop = cursor.y;
            rowBottom = cursor.y;
          }
          const x = left + column * columnWidth;
          doc
            .font(SANS_BOLD)
            .fontSize(SIZE.label)
            .fillColor(LABEL)
            .text(entry.label, x, rowTop, { width: columnWidth - mm(3) });
          doc
            .font(SANS)
            .fontSize(SIZE.body)
            .fillColor(INK)
            .text(entry.value, x, doc.y + 0.5, {
              width: columnWidth - mm(3),
              lineGap: LINE_GAP,
            });
          rowBottom = Math.max(rowBottom, doc.y);

          column += 1;
          if (column === block.columns) {
            column = 0;
            cursor.y = rowBottom + mm(2.5);
          }
        }
        if (column !== 0) cursor.y = rowBottom + mm(2.5);
        return;
      }

      case 'table':
        this.paintTable(doc, block.columns, block.rows, left, width, cursor, ensure); // prettier-ignore
        return;

      case 'signature': {
        ensure(mm(26));
        // DOC-057, DOC-060. The template's box on the right: where a hand signs.
        const boxWidth = mm(55);
        const boxHeight = mm(18);
        const boxLeft = left + width - boxWidth;
        const chosen =
          block.image === 'seal'
            ? images.seal
            : block.image === 'signature'
              ? images.signature
              : null;

        if (chosen !== null) {
          doc.image(chosen.bytes, boxLeft, cursor.y, {
            fit: [boxWidth, boxHeight],
            align: 'center',
            valign: 'center',
          });
        } else {
          // DOC-060. A LABELLED EMPTY BOX, never a drawn seal. The system
          // cannot manufacture one, and art. 5.d.iii is textual: «no se
          // aceptarán rúbricas o trazos por firma». An empty box is a document
          // missing a seal; a squiggle would be a forged one.
          doc
            .rect(boxLeft, cursor.y, boxWidth, boxHeight)
            .lineWidth(0.75)
            .strokeColor(EMPTY_BOX)
            .dash(2, { space: 2 })
            .stroke()
            .undash();
        }

        doc
          .font(SANS)
          .fontSize(SIZE.label)
          .fillColor(LABEL)
          .text(block.caption, boxLeft, cursor.y + boxHeight + mm(1), {
            width: boxWidth,
            align: 'center',
          });
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

      case 'boxes': {
        // DOC-076. The SRI's Anexo 2 puts the issuer and the voucher side by
        // side. Both boxes are painted from the same top, and the cursor moves
        // to the taller of the two.
        const gap = mm(4);
        const half = (width - gap) / 2;
        const top = cursor.y;

        const paintColumn = (blocks: readonly Block[], x: number): number => {
          const inner: Cursor = { y: top + mm(3) };
          for (const child of blocks) {
            this.paintBlock(
              doc,
              child,
              images,
              x + mm(3),
              half - mm(6),
              inner,
              () => undefined,
            );
          }
          return inner.y;
        };

        const leftBottom = paintColumn(block.left, left);
        const rightBottom = paintColumn(block.right, left + half + gap);
        const bottom = Math.max(leftBottom, rightBottom) + mm(2);

        doc
          .rect(left, top, half, bottom - top)
          .rect(left + half + gap, top, half, bottom - top)
          .lineWidth(0.75)
          .strokeColor(INK)
          .stroke();

        cursor.y = bottom + mm(4);
        return;
      }
    }
  }

  /**
   * DOC-085. A table whose column widths are fractions of the text width, with
   * a header row and 1 px rules. Rows are measured before painting and moved
   * to the next page whole.
   */
  private paintTable(
    doc: PDFKit.PDFDocument,
    columns: readonly TableColumn[],
    rows: readonly (readonly string[])[],
    left: number,
    width: number,
    cursor: Cursor,
    ensure: (height: number) => void,
  ): void {
    const widths = columns.map((column) => column.width * width);
    const align = (column: TableColumn): 'left' | 'right' | 'center' =>
      column.align === 'right'
        ? 'right'
        : column.align === 'centre'
          ? 'center'
          : 'left';

    /** `noUncheckedIndexedAccess` is on, and the two arrays are the same length. */
    const widthAt = (index: number): number => widths[index] ?? 0;

    const rule = (y: number, colour: string): void => {
      doc
        .moveTo(left, y)
        .lineTo(left + width, y)
        .lineWidth(0.75)
        .strokeColor(colour)
        .stroke();
    };

    const paintHeaderRow = (): void => {
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

    for (const row of rows) {
      // Measure first: a row that does not fit moves whole, so no line of a
      // prescription is ever split across two pages.
      const heights = row.map((cell, index) =>
        doc
          .font(SANS)
          .fontSize(SIZE.body)
          .heightOfString(cell, { width: widthAt(index) - mm(1.5) }),
      );
      const rowHeight = Math.max(...heights, mm(4.5));

      // A row that does not fit moves WHOLE to the next page: half a
      // prescription line across a page break is a line somebody misreads.
      ensure(rowHeight + mm(3));

      let x = left;
      doc.font(SANS).fontSize(SIZE.body).fillColor(INK);
      row.forEach((cell, index) => {
        const column = columns[index];
        doc.text(cell, x, cursor.y, {
          width: widthAt(index) - mm(1.5),
          align: column === undefined ? 'left' : align(column),
        });
        x += widthAt(index);
      });
      cursor.y += rowHeight + mm(1.5);
      rule(cursor.y, RULE_LIGHT);
      cursor.y += mm(1.5);
    }

    cursor.y += mm(2);
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

    doc
      .moveTo(left, cutY)
      .lineTo(left + width, cutY)
      .lineWidth(0.75)
      .strokeColor(LABEL)
      .dash(4, { space: 3 })
      .stroke()
      .undash();

    const cursor: Cursor = { y: cutY + mm(3) };
    const identification: Block = {
      kind: 'fields',
      columns: 2,
      entries: band.identification,
    };

    doc
      .font(SANS_BOLD)
      .fontSize(SIZE.label)
      .fillColor(LABEL)
      .text(band.caption, left, cursor.y, { width, align: 'center' });
    cursor.y = doc.y + mm(1.5);

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
      this.paintBlock(doc, block, images, left, width, sealCursor, () => undefined); // prettier-ignore
    }

    /**
     * DOC-073. THE BAND NEVER RUNS INTO THE PAGE EDGE. What does not fit goes
     * on to a new page — with the establishment's header (DOC-071) and the
     * patient's name and date again, because a detached strip that does not
     * say whose it is is a loose piece of paper. Overflowing was printing the
     * last indications over the footer, and then on a page with nobody's name.
     */
    let bottom = doc.page.height - mm(PAGE_MARGIN_MM);
    const ensure = (height: number): void => {
      if (cursor.y + height <= bottom) return;
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
      this.paintBlock(doc, identification, images, left, width, cursor, () => undefined); // prettier-ignore
    };

    this.paintBlock(doc, identification, images, left, textWidth, cursor, ensure); // prettier-ignore
    for (const block of text) {
      this.paintBlock(
        doc,
        block,
        images,
        left,
        textWidth,
        cursor,
        ensure,
        layout.frame.accentColour,
      );
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
 * DOC-073, DOC-083. Where the footer starts. On a receta it sits ABOVE the cut
 * line, so the part the pharmacy keeps carries the QR, the verification URL
 * and «Página x de y»; the strip the patient takes is only theirs.
 */
function footerTopOf(doc: PDFKit.PDFDocument, layout: DocumentLayout): number {
  return layout.tearOff === null
    ? doc.page.height - mm(PAGE_MARGIN_MM) - mm(FOOTER_HEIGHT_MM)
    : doc.page.height - mm(TEAR_OFF_HEIGHT_MM) - mm(2) - mm(FOOTER_HEIGHT_MM);
}
