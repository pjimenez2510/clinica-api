import './infrastructure/documents.constraints';
import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common'; // prettier-ignore
import { ConfigService } from '@nestjs/config';
import express from 'express';

import type { Env } from '../../shared/config/env.schema';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import {
  RIDE_ISSUER,
  type RideIssuer,
} from '../../shared/documents/ride-issuer.port';
import { ANNULLED_DOCUMENT_ARCHIVER } from '../../shared/documents/annulled-document.port';
import {
  CLINICAL_RECORD_COPY_FREEZER,
  type ClinicalRecordCopyFreezer,
} from '../../shared/documents/clinical-record-copy-freezer.port';

import { DocumentIdentityController } from './document-identity.controller';
import { DocumentTemplatesController } from './document-templates.controller';
import { DocumentVerificationController } from './document-verification.controller';
import { ClinicalRecordCopyController } from './clinical-record-copy.controller';
import { DocumentsController } from './documents.controller';
import { InvoiceDocumentsController } from './invoice-documents.controller';
import { AnnulledDocumentArchiverService } from './application/annulled-document.archiver';
import { DocumentIdentityService } from './application/document-identity.service';
import { DocumentService } from './application/document.service';
import { DocumentVerificationService } from './application/document-verification.service';
import { DOCUMENT_RENDERER, IMAGE_NORMALISER } from './domain/document-rendering.port'; // prettier-ignore
import {
  DOCUMENT_SOURCE_READER,
  type DocumentSourceReader,
  DOCUMENT_VERIFICATION_BASE_URL,
} from './domain/document-source';
import { DOCUMENT_REPOSITORY } from './domain/document.repository';
import { MAX_IMAGE_BYTES } from './domain/document-image';
import { PdfKitDocumentRenderer } from './infrastructure/pdfkit-document.renderer';
import { PrismaDocumentRepository } from './infrastructure/prisma-document.repository';
import { PrismaDocumentSourceReader } from './infrastructure/prisma-document-source.reader';
import { SharpImageNormaliser } from './infrastructure/sharp-image.normaliser';

/**
 * The printable document, and the artefact that stays.
 *
 * Composition root: the only place where this module's ports meet concrete
 * infrastructure. Neither service ever sees Prisma, PDFKit or sharp, which is
 * what lets the content of art. 5, the tear-off geometry and the image rules be
 * exercised with plain objects, while the guarantees that matter — the
 * immutability of the artefact, the coherence of a supersession — are exercised
 * against a real PostgreSQL.
 *
 * `CurrentUserService` is PROVIDED here rather than imported from `AuthModule`:
 * no module imports another, and the service itself lives in
 * `shared/authorisation` because every module needs to know who is asking. It
 * reads `ClsService`, which is global, so providing it twice costs nothing.
 *
 * ⚠️ IT DOES NOT WIRE AN ACCESS AUDIT RECORDER, unlike `PrescriptionModule` and
 * `EncounterModule`, AND THAT IS THE DECISION RATHER THAN AN OMISSION.
 * `ACCESS_AUDIT_RECORDER` states its own policy: it must never throw into the
 * caller's path, because refusing to show a doctor a chart when the audit table
 * is unreachable is the wrong trade in a clinic. The same comment says that «an
 * EXPORT or a PRINT of clinical data, when they exist, must» instead write
 * inside their own transaction. THIS MODULE IS THAT PRINT — what leaves is a
 * FILE, forwardable and storable, not a screen somebody looked at — so the
 * trail is written by the repository, in the same transaction as the artefact,
 * and it FAILS CLOSED: no trail, no bytes (DOC-091).
 *
 * ⚠️ TWO SERVICES, AND IT IS ADR-008 §2 APPLIED RATHER THAN SYMMETRY.
 * `DocumentIdentityService` shares NO dependency with `DocumentService` — no
 * source reader, no renderer, no template — and changes for an entirely
 * different reason: a logo is uploaded once a decade by whoever administers the
 * clinic, an artefact is emitted a hundred times a day by whoever attends.
 */
@Global()
@Module({
  controllers: [
    DocumentsController,
    ClinicalRecordCopyController,
    InvoiceDocumentsController,
    DocumentTemplatesController,
    DocumentIdentityController,
    DocumentVerificationController,
  ],
  providers: [
    DocumentService,
    DocumentIdentityService,
    DocumentVerificationService,
    CurrentUserService,
    { provide: DOCUMENT_REPOSITORY, useClass: PrismaDocumentRepository },
    { provide: DOCUMENT_SOURCE_READER, useClass: PrismaDocumentSourceReader },
    /**
     * DOC-083. The public verification page of the web app. Read from the
     * validated environment, like the credential links of `auth`.
     */
    {
      provide: DOCUMENT_VERIFICATION_BASE_URL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): string =>
        `${config.get('WEB_BASE_URL', { infer: true })}/verificar`,
    },
    /**
     * DOC-020 to DOC-024. PDFKit, because it is the ONLY JavaScript library
     * that generates native PDF/A — and IHE requires PDF/A-1b for shared
     * clinical documents. See the renderer's own header for what it was chosen
     * against, and `embedded-fonts.ts` for the trap it hides: its fourteen
     * standard fonts are metrics only and CANNOT be embedded, so a document
     * that uses them is not PDF/A and PDFKit does not warn.
     */
    { provide: DOCUMENT_RENDERER, useClass: PdfKitDocumentRenderer },
    { provide: IMAGE_NORMALISER, useClass: SharpImageNormaliser },
    /**
     * DOC-122. What `privacy` freezes with the answer that authorises a copy
     * of the clinical record: the print data as it stands then, composed by
     * the same reader that serves the download.
     */
    {
      provide: CLINICAL_RECORD_COPY_FREEZER,
      inject: [DOCUMENT_SOURCE_READER],
      useFactory: (
        reader: DocumentSourceReader,
      ): ClinicalRecordCopyFreezer => ({
        freeze: (input) => reader.freezeClinicalRecordCopy(input),
      }),
    },
    /**
     * SRI-072, SRI-089. The RIDE `sri` attaches to the e-mail of an
     * authorised voucher —an invoice's or a credit note's—: emitted and FILED
     * here like any other (DOC-002), in the name of whoever issued the
     * document, and read back as the stored bytes. `@Global` exports
     * this token and `ANNULLED_DOCUMENT_ARCHIVER`, nothing else of the module.
     */
    {
      provide: RIDE_ISSUER,
      inject: [DocumentService],
      useFactory: (documents: DocumentService): RideIssuer => {
        // Emitted and read back as the stored bytes, in the name of whoever
        // issued the voucher's document: an automatic delivery has nobody
        // else behind it.
        const issue = async (
          kind: 'INVOICE_RIDE' | 'CREDIT_NOTE_RIDE',
          subjectId: string,
          issuedById: string,
        ) => {
          const requester = { userId: issuedById, sites: 'all' as const };
          const summary = await documents.emit({ kind, subjectId }, requester);
          const stored = await documents.content(summary.id, [kind], requester);
          return stored.content;
        };
        return {
          async issueRide(invoiceId, issuedById) {
            const content = await issue('INVOICE_RIDE', invoiceId, issuedById);
            return { content, fileName: `RIDE-${invoiceId}.pdf` };
          },
          // SRI-089. The credit note's, on the same template.
          async issueCreditNoteRide(creditNoteId, issuedById) {
            const content = await issue(
              'CREDIT_NOTE_RIDE',
              creditNoteId,
              issuedById,
            );
            return { content, fileName: `RIDE-NC-${creditNoteId}.pdf` };
          },
        };
      },
    },
    /**
     * DOC-109. The PDF that replaces the archived one after a receta, an exam
     * or a certificate is annulled: `prescription`, `orders` and
     * `certificates` call it once their annulment is committed, and it never
     * fails them.
     */
    {
      provide: ANNULLED_DOCUMENT_ARCHIVER,
      useClass: AnnulledDocumentArchiverService,
    },
  ],
  exports: [
    RIDE_ISSUER,
    ANNULLED_DOCUMENT_ARCHIVER,
    CLINICAL_RECORD_COPY_FREEZER,
  ],
})
export class DocumentsModule implements NestModule {
  /**
   * DOC-052. THE BYTE CAP, APPLIED AT THE SOCKET.
   *
   * The images arrive as raw bytes and not as base64 inside JSON, because the
   * cap has to apply BEFORE anything decodes — and base64 inflates a 512 KB
   * file to about 700 KB of string that Express must parse and hold first.
   * `limit` makes Express refuse a larger body itself, with a 413, before a
   * byte of it reaches this module.
   *
   * `type: () => true` on these paths only: whatever the `Content-Type` says,
   * the body is captured as a Buffer and the FORMAT IS DECIDED FROM THE MAGIC
   * BYTES (DOC-050). Letting the parser filter by media type would mean an SVG
   * labelled `image/png` reached the same code path as a real PNG anyway, while
   * an honest `image/svg+xml` fell through to a confusing 415 instead of the
   * sentence that explains why SVG is refused.
   *
   * ⚠️ IT DOES NOT AFFECT THE JSON ROUTES. `configureApp` registers the JSON
   * parser for `application/json`, and the identity controller is the only one
   * this middleware is mounted on — its GETs too (DOC-061), where a body-less
   * request makes it a no-op.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        express.raw({
          type: () => true,
          limit: MAX_IMAGE_BYTES,
        }),
      )
      .forRoutes(DocumentIdentityController);
  }
}
