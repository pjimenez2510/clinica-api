import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import type {
  AnnulledDocument,
  AnnulledDocumentArchiver,
} from '../../../shared/documents/annulled-document.port';

import { DocumentService } from './document.service';

/**
 * DOC-109. The shared port other modules call once an annulment is committed:
 * files the PDF that replaces the archived one (`archiveReplacement`).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AFTER THE ANNULMENT, AND IT NEVER FAILS IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not inside the annulment's transaction: composing a PDF —fonts, images, a
 * template— holding the lock of the receta would make the clinical act depend
 * on the printer, and the act is the register art. 70 asks for, not the file.
 * So the annulment commits first, this runs right after it in the same
 * request, and whatever goes wrong is logged and swallowed. The previous PDF
 * stays archived, and «Corregir…» (DOC-108) archives the new one later.
 *
 * Filed in the name of whoever annulled, without a site scope: the annulment
 * was already authorised within theirs, and the subject's own site is what
 * the document prints (like the RIDE of `RIDE_ISSUER`).
 */
@Injectable()
export class AnnulledDocumentArchiverService implements AnnulledDocumentArchiver {
  constructor(
    private readonly documents: DocumentService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AnnulledDocumentArchiverService.name);
  }

  async archiveAnnulled(document: AnnulledDocument): Promise<boolean> {
    try {
      const archived = await this.documents.archiveReplacement(
        {
          kind: document.kind,
          subjectId: document.subjectId,
          cause: document.cause,
        },
        { userId: document.userId, sites: 'all' },
      );
      return archived !== null;
    } catch {
      // The kind only: the error may carry what the document says (DOC-093).
      this.logger.warn(
        { action: 'ANNULLED_DOCUMENT_NOT_ARCHIVED', kind: document.kind },
        'annulled document could not be archived',
      );
      return false;
    }
  }
}
