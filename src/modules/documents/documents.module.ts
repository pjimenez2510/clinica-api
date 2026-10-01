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

import { DocumentIdentityController } from './document-identity.controller';
import { DocumentTemplatesController } from './document-templates.controller';
import { DocumentVerificationController } from './document-verification.controller';
import { DocumentsController } from './documents.controller';
import { InvoiceDocumentsController } from './invoice-documents.controller';
import { DocumentIdentityService } from './application/document-identity.service';
import { DocumentService } from './application/document.service';
import { DocumentVerificationService } from './application/document-verification.service';
import { DOCUMENT_RENDERER, IMAGE_NORMALISER } from './domain/document-rendering.port'; // prettier-ignore
import {
  DOCUMENT_SOURCE_READER,
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
     * SRI-072. The RIDE `sri` attaches to the e-mail of an authorised voucher:
     * emitted and FILED here like any other (DOC-002), in the name of whoever
     * issued the invoice, and read back as the stored bytes. `@Global` exports
     * this token and nothing else of the module.
     */
    {
      provide: RIDE_ISSUER,
      inject: [DocumentService],
      useFactory: (documents: DocumentService): RideIssuer => ({
        async issueRide(invoiceId, issuedById) {
          const requester = { userId: issuedById, sites: 'all' as const };
          const summary = await documents.emit(
            { kind: 'INVOICE_RIDE', subjectId: invoiceId },
            requester,
          );
          const stored = await documents.content(
            summary.id,
            ['INVOICE_RIDE'],
            requester,
          );
          return { content: stored.content, fileName: `RIDE-${invoiceId}.pdf` };
        },
      }),
    },
  ],
  exports: [RIDE_ISSUER],
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
