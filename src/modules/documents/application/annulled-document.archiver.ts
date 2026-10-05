import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import type {
  AnnulledDocument,
  AnnulledDocumentArchiver,
  DocumentArchived,
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

  async archiveAnnulled(document: AnnulledDocument): Promise<DocumentArchived> {
    try {
      const archived = await this.documents.archiveReplacement(
        {
          kind: document.kind,
          subjectId: document.subjectId,
          cause: document.cause,
        },
        { userId: document.userId, sites: 'all' },
      );
      return archived === null ? null : true;
    } catch (error) {
      // Which subject and which failure, NEVER the message: it may carry what
      // the document says (DOC-093). The name tells a font from a lock, and
      // Prisma's code tells which constraint.
      this.logger.warn(
        {
          action: 'ANNULLED_DOCUMENT_NOT_ARCHIVED',
          subject_id: document.subjectId,
          document_type: document.kind,
          type: error instanceof Error ? error.name : typeof error,
          error_code: prismaCodeOf(error),
        },
        'annulled document could not be archived',
      );
      return false;
    }
  }
}

/** `P2002` and the like: Prisma's stable code, without importing Prisma. */
function prismaCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^P\d{4}$/.test(code) ? code : undefined;
}
