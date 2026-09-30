import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

import { DocumentRenderFailedError } from '../domain/document.errors';
import {
  PAGE_MARGIN_MM,
  TEAR_OFF_HEIGHT_MM,
  millimetresToPoints,
} from '../domain/page-layout';
import {
  BOLD_FONT,
  FONT_BOLD,
  FONT_REGULAR,
  REGULAR_FONT,
} from './embedded-fonts';
import type {
  DocumentMetadata,
  DocumentRenderer,
  LayoutImages,
} from '../domain/document-rendering.port';
import type {
  Block,
  DocumentHeader,
  DocumentLayout,
  TableColumn,
} from '../domain/page-layout';

/**
 * DOC-020 to DOC-024, DOC-070 to DOC-078. The layout, painted as PDF/A-1b.
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

/** Short alias: every coordinate below is written in millimetres. */
const mm = millimetresToPoints;

/** Type sizes, in points. One place, so a document cannot drift by section. */
const SIZE = { title: 15, heading: 10, body: 9, small: 7.5 } as const;
const LINE_GAP = 2;

/** DOC-071. Reserved at the foot of every page for the page number. */
const FOOTER_HEIGHT_MM = 12;

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
    doc.registerFont(FONT_REGULAR, REGULAR_FONT);
    doc.registerFont(FONT_BOLD, BOLD_FONT);

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
    const reserved =
      mm(FOOTER_HEIGHT_MM) + (layout.tearOff === null ? 0 : mm(TEAR_OFF_HEIGHT_MM)); // prettier-ignore
    const bottomLimit = doc.page.height - mm(PAGE_MARGIN_MM) - reserved;

    const cursor: Cursor = { y: 0 };

    const startPage = (): void => {
      cursor.y = mm(PAGE_MARGIN_MM);
      this.paintHeader(doc, layout, images, left, contentWidth, cursor);
    };

    const ensure = (height: number): void => {
      if (cursor.y + height <= bottomLimit) return;
      doc.addPage();
      startPage();
    };

    startPage();
    this.paintTitle(doc, layout, left, contentWidth, cursor);

    for (const block of layout.blocks) {
      this.paintBlock(doc, block, images, left, contentWidth, cursor, ensure);
    }

    // DOC-073. The band goes on the page the document ends on, at its fixed
    // position — not wherever the text stopped.
    if (layout.tearOff !== null) {
      this.paintTearOff(doc, layout, images, left, contentWidth);
    }

    this.paintFooters(doc, layout, left, contentWidth);

    doc.end();
    return finished;
  }

  // ── header ───────────────────────────────────────────────────────────────

  /**
   * DOC-071. The establishment on EVERY page.
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
    const header: DocumentHeader = layout.header;
    const logoWidth = mm(28);
    const logoHeight = mm(16);
    let textLeft = left;
    let textWidth = width;

    if (header.hasLogo && images.logo !== null) {
      doc.image(images.logo.bytes, left, cursor.y, {
        fit: [logoWidth, logoHeight],
      });
      textLeft = left + logoWidth + mm(4);
      textWidth = width - logoWidth - mm(4);
    }

    doc
      .font(FONT_BOLD)
      .fontSize(SIZE.heading)
      .fillColor('#000000')
      .text(header.establishmentName, textLeft, cursor.y, { width: textWidth });

    const details = [
      header.establishmentRuc === null
        ? null
        : `RUC ${header.establishmentRuc}`,
      header.establishmentAddress,
      header.establishmentPhone,
      ...header.fields.map((field) => `${field.label}: ${field.value}`),
    ].filter((entry): entry is string => entry !== null && entry !== '');

    if (details.length > 0) {
      doc
        .font(FONT_REGULAR)
        .fontSize(SIZE.small)
        .text(details.join(' · '), textLeft, doc.y, { width: textWidth });
    }

    const bottom = Math.max(
      doc.y,
      header.hasLogo && images.logo !== null ? cursor.y + logoHeight : doc.y,
    );

    doc
      .moveTo(left, bottom + mm(2))
      .lineTo(left + width, bottom + mm(2))
      .lineWidth(1)
      .strokeColor(layout.accentColour)
      .stroke();

    cursor.y = bottom + mm(5);
  }

  /**
   * The document's title in the template's accent colour, and the verification
   * code under it when the subject has one.
   */
  private paintTitle(
    doc: PDFKit.PDFDocument,
    layout: DocumentLayout,
    left: number,
    width: number,
    cursor: Cursor,
  ): void {
    doc
      .font(FONT_BOLD)
      .fontSize(SIZE.title)
      .fillColor(layout.accentColour)
      .text(layout.title, left, cursor.y, { width, align: 'center' });

    if (layout.reference !== null) {
      doc
        .font(FONT_REGULAR)
        .fontSize(SIZE.small)
        .fillColor('#000000')
        .text(`Código de verificación: ${layout.reference}`, left, doc.y, {
          width,
          align: 'center',
        });
    }

    cursor.y = doc.y + mm(4);
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
          .lineWidth(0.5)
          .strokeColor('#999999')
          .stroke();
        cursor.y += mm(3);
        return;

      case 'heading':
        ensure(mm(8));
        doc
          .font(FONT_BOLD)
          .fontSize(SIZE.heading)
          .fillColor('#000000')
          .text(block.text, left, cursor.y, { width });
        cursor.y = doc.y + mm(1.5);
        return;

      case 'paragraph':
        ensure(mm(6));
        doc
          .font(block.emphasis === true ? FONT_BOLD : FONT_REGULAR)
          .fontSize(SIZE.body)
          .fillColor('#000000')
          .text(block.text, left, cursor.y, { width, lineGap: LINE_GAP });
        cursor.y = doc.y + mm(2);
        return;

      case 'fields': {
        const columnWidth = width / block.columns;
        let column = 0;
        let rowTop = cursor.y;
        let rowBottom = cursor.y;

        for (const entry of block.entries) {
          if (column === 0) {
            ensure(mm(8));
            rowTop = cursor.y;
            rowBottom = cursor.y;
          }
          const x = left + column * columnWidth;
          doc
            .font(FONT_BOLD)
            .fontSize(SIZE.small)
            .fillColor('#555555')
            .text(entry.label, x, rowTop, { width: columnWidth - mm(3) });
          doc
            .font(FONT_REGULAR)
            .fontSize(SIZE.body)
            .fillColor('#000000')
            .text(entry.value, x, doc.y, {
              width: columnWidth - mm(3),
              lineGap: LINE_GAP,
            });
          rowBottom = Math.max(rowBottom, doc.y);

          column += 1;
          if (column === block.columns) {
            column = 0;
            cursor.y = rowBottom + mm(2);
          }
        }
        if (column !== 0) cursor.y = rowBottom + mm(2);
        return;
      }

      case 'table':
        this.paintTable(doc, block.columns, block.rows, left, width, cursor, ensure); // prettier-ignore
        return;

      case 'signature': {
        ensure(mm(24));
        const boxWidth = mm(60);
        const boxHeight = mm(16);
        const chosen =
          block.image === 'seal'
            ? images.seal
            : block.image === 'signature'
              ? images.signature
              : null;

        if (chosen !== null) {
          doc.image(chosen.bytes, left, cursor.y, {
            fit: [boxWidth, boxHeight],
          });
        } else {
          // DOC-060. A LABELLED EMPTY BOX, never a drawn seal. The system
          // cannot manufacture one, and art. 5.d.iii is textual: «no se
          // aceptarán rúbricas o trazos por firma». An empty box is a document
          // missing a seal; a squiggle would be a forged one.
          doc
            .rect(left, cursor.y, boxWidth, boxHeight)
            .lineWidth(0.5)
            .strokeColor('#bbbbbb')
            .dash(2, { space: 2 })
            .stroke()
            .undash();
        }

        doc
          .font(FONT_REGULAR)
          .fontSize(SIZE.small)
          .fillColor('#555555')
          .text(block.caption, left, cursor.y + boxHeight + mm(1), {
            width: boxWidth,
          });
        cursor.y = doc.y + mm(3);
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
          .lineWidth(0.5)
          .strokeColor('#999999')
          .stroke();

        cursor.y = bottom + mm(4);
        return;
      }
    }
  }

  /**
   * A table whose column widths are fractions of the text width. Rows are
   * measured before painting and moved to the next page whole.
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

    const paintHeaderRow = (): void => {
      let x = left;
      doc.font(FONT_BOLD).fontSize(SIZE.small).fillColor('#555555');
      columns.forEach((column, index) => {
        doc.text(column.header, x, cursor.y, {
          width: widthAt(index) - mm(1),
          align: align(column),
        });
        x += widthAt(index);
      });
      cursor.y += mm(5);
      doc
        .moveTo(left, cursor.y - mm(1))
        .lineTo(left + width, cursor.y - mm(1))
        .lineWidth(0.5)
        .strokeColor('#cccccc')
        .stroke();
    };

    ensure(mm(14));
    paintHeaderRow();

    for (const row of rows) {
      // Measure first: a row that does not fit moves whole, so no line of a
      // prescription is ever split across two pages.
      const heights = row.map((cell, index) =>
        doc
          .font(FONT_REGULAR)
          .fontSize(SIZE.body)
          .heightOfString(cell, { width: widthAt(index) - mm(1) }),
      );
      const rowHeight = Math.max(...heights, mm(5));

      // A row that does not fit moves WHOLE to the next page: half a
      // prescription line across a page break is a line somebody misreads.
      ensure(rowHeight + mm(2));

      let x = left;
      doc.font(FONT_REGULAR).fontSize(SIZE.body).fillColor('#000000');
      row.forEach((cell, index) => {
        const column = columns[index];
        doc.text(cell, x, cursor.y, {
          width: widthAt(index) - mm(1),
          align: column === undefined ? 'left' : align(column),
        });
        x += widthAt(index);
      });
      cursor.y += rowHeight + mm(1.5);
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
  ): void {
    const band = layout.tearOff;
    if (band === null) return;

    const cutY = doc.page.height - mm(TEAR_OFF_HEIGHT_MM);

    doc
      .moveTo(left, cutY)
      .lineTo(left + width, cutY)
      .lineWidth(0.75)
      .strokeColor('#666666')
      .dash(4, { space: 3 })
      .stroke()
      .undash();

    const cursor: Cursor = { y: cutY + mm(3) };

    doc
      .font(FONT_BOLD)
      .fontSize(SIZE.small)
      .fillColor('#666666')
      .text(band.caption, left, cursor.y, { width });
    cursor.y = doc.y + mm(1);

    this.paintBlock(
      doc,
      { kind: 'fields', columns: 2, entries: band.identification },
      images,
      left,
      width,
      cursor,
      () => undefined,
    );

    for (const block of band.blocks) {
      this.paintBlock(doc, block, images, left, width, cursor, () => undefined);
    }
  }

  /** DOC-071. «Página N de M» on every page, once the total is known. */
  private paintFooters(
    doc: PDFKit.PDFDocument,
    layout: DocumentLayout,
    left: number,
    width: number,
  ): void {
    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      doc.switchToPage(range.start + index);
      const y = doc.page.height - mm(PAGE_MARGIN_MM) - mm(5);
      const text = [layout.footerText, `Página ${index + 1} de ${range.count}`]
        .filter((entry): entry is string => entry !== null && entry !== '')
        .join(' · ');

      doc
        .font(FONT_REGULAR)
        .fontSize(SIZE.small)
        .fillColor('#666666')
        .text(text, left, y, { width, align: 'center' });
    }
    // Without this, `end()` flushes while the cursor sits on the first page and
    // PDFKit appends nothing further — harmless today, and a trap for whoever
    // adds a final block later.
    doc.flushPages();
  }
}
