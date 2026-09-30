import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';
import type { Permission } from '../../shared/authorisation/permission.catalogue';

import { DocumentService } from './application/document.service';
import { DocumentRenderNotFoundError } from './domain/document.errors';
import { toRenderResponse } from './documents.presenter';
import {
  DocumentRenderDto,
  RenderRequestDto,
  SupersedeRequestDto,
  type DocumentRenderResponse,
} from './dto/documents.dto';
import type {
  RenderedDocument,
  Requester,
} from './application/document.service';
import { CLINICAL_DOCUMENT_KINDS } from './domain/document-kind';
import type { ClinicalDocumentKind } from './domain/document-kind';
import type { StoredDocument } from './domain/document.repository';

/**
 * The clinical documents: the draft, the emission, the metadata and the bytes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `record:read` ON ALL FOUR, AND NO NEW PERMISSION (DOC-090)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Emitting the artefact reveals NOTHING the caller could not already read: it
 * is the same information, in a file. Inventing `document:issue` would have
 * created a permission no shipped role carries, and the result would be a
 * clinic unable to print a receta on the day it is installed — while the ACESS
 * art. 9 copy is an obligation from that same day.
 *
 * ⚠️ THE SEPARATION THAT DOES MATTER IS THE OTHER ONE: the RIDE is NOT served
 * here. A tax document is not clinical content, and whoever may open a chart
 * has no business being handed an invoice because both happen to be PDFs. It
 * lives on `InvoiceDocumentsController` under `billing:read`, and the service
 * refuses a RIDE through these routes because `kind` is typed to the three
 * clinical ones.
 *
 * ⚠️ AND THERE IS NO ROUTE THAT MODIFIES OR DELETES AN ARTEFACT (DOC-011). Not
 * «not yet»: `trg_document_render_immutable` refuses the statement in the
 * database, and the absence here is the same guarantee said in code. Correcting
 * a document is `POST /supersede`, which emits a new one.
 */
@ApiTags('documents')
@Controller({ path: 'documents', version: '1' })
export class DocumentsController {
  constructor(
    private readonly documents: DocumentService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * DOC-001. A draft: the bytes, and nothing stored.
   *
   * ⚠️ `POST` AND NOT `GET`, even though it changes no state the caller can
   * observe. The request body carries the subject and the kind, and it IS
   * recorded in the access trail — a draft is the same file as the emitted one,
   * so «quién se lo llevó» has to be answerable either way (DOC-091).
   */
  @Post('drafts')
  @RequirePermission('record:read', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Previsualizar el documento sin archivarlo' })
  @ApiProduces('application/pdf')
  async draft(
    @Body() body: RenderRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const rendered = await this.documents.draft(
      { kind: body.kind as ClinicalDocumentKind, subjectId: body.subjectId },
      this.requester(req, 'record:read'),
    );
    sendPdf(res, rendered);
  }

  /**
   * DOC-002. Emits the artefact.
   *
   * 201 AND THE METADATA, NOT THE BYTES. What was created is a row in the
   * archive; the file is fetched from `…/content`, which is the route that
   * leaves the trail of a disclosure. Returning the PDF here would make «emitir»
   * and «descargar» the same act and impossible to tell apart in the audit.
   */
  @Post('renders')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Emitir y archivar el documento' })
  @ApiCreatedResponse({ type: DocumentRenderDto })
  async emit(
    @Body() body: RenderRequestDto,
    @Req() req: Request,
  ): Promise<DocumentRenderResponse> {
    const stored = await this.documents.emit(
      { kind: body.kind as ClinicalDocumentKind, subjectId: body.subjectId },
      this.requester(req, 'record:read'),
    );
    return toRenderResponse(stored);
  }

  /**
   * DOC-007. Corrects an emitted document by emitting a NEW one that annuls it.
   *
   * ⚠️ IT IS NOT A `PATCH` OF THE PREVIOUS ONE, and it never will be. Ley 67
   * art. 7 requires being able to show the document kept its integrity «desde
   * que se generó en su forma definitiva»; the earlier artefact keeps saying
   * what it said, and the new one says why it no longer applies.
   */
  @Post('renders/supersede')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Emitir un documento que anula a otro, diciendo por qué' }) // prettier-ignore
  @ApiCreatedResponse({ type: DocumentRenderDto })
  async supersede(
    @Body() body: SupersedeRequestDto,
    @Req() req: Request,
  ): Promise<DocumentRenderResponse> {
    const stored = await this.documents.emit(
      {
        kind: body.kind as ClinicalDocumentKind,
        subjectId: body.subjectId,
        supersedesId: body.supersedesId,
        reason: body.reason,
      },
      this.requester(req, 'record:read'),
    );
    return toRenderResponse(stored);
  }

  /**
   * DOC-092. The metadata. DELIBERATELY NOT AUDITED.
   *
   * What comes back is a class, a size, a hash, an instant and an author —
   * nothing about a person's health. Auditing what reveals nothing trains
   * everybody to ignore the trail, which is where what does reveal something
   * lives.
   */
  @Get('renders/:renderId')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Consultar los datos del documento archivado' })
  @ApiOkResponse({ type: DocumentRenderDto })
  async metadata(
    @Param('renderId', ParseUUIDPipe) renderId: string,
    @Req() req: Request,
  ): Promise<DocumentRenderResponse> {
    const summary = await this.documents.metadata(
      renderId,
      CLINICAL_DOCUMENT_KINDS,
      this.requester(req, 'record:read'),
    );
    return toRenderResponse(summary);
  }

  /**
   * DOC-006, DOC-091. Reprinting: THE STORED BYTES, never a recomposition.
   *
   * The `ETag` is the artefact's own `sha256`, which is the strongest validator
   * this system can offer and costs nothing: the file cannot change, so a
   * cached copy is valid for ever.
   */
  @Get('renders/:renderId/content')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Descargar el documento archivado, tal como se emitió' }) // prettier-ignore
  @ApiProduces('application/pdf')
  async content(
    @Param('renderId', ParseUUIDPipe) renderId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const stored = await this.documents.content(
      renderId,
      // DOC-090. A RIDE is never served through a `record:read` route, even to
      // somebody who guessed its identifier.
      CLINICAL_DOCUMENT_KINDS,
      this.requester(req, 'record:read'),
    );
    sendStored(res, stored);
  }

  /** The artefacts of one subject, newest first. Includes the annulled ones. */
  @Get('subjects/:kind/:subjectId/renders')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Listar los documentos emitidos de una receta, orden o certificado' }) // prettier-ignore
  @ApiOkResponse({ type: [DocumentRenderDto] })
  async history(
    @Param('kind') kind: string,
    @Param('subjectId', ParseUUIDPipe) subjectId: string,
    @Req() req: Request,
  ): Promise<DocumentRenderResponse[]> {
    // The path parameter is validated HERE and not by a pipe, because what
    // makes it valid is not «is it a DocumentKind» but «is it one of the three
    // this permission covers» (DOC-090). `INVOICE_RIDE` is a real kind and is
    // refused all the same.
    if (!isAllowedHere(kind)) throw new DocumentRenderNotFoundError();

    const renders = await this.documents.history(
      { kind, subjectId },
      this.requester(req, 'record:read'),
    );
    return renders.map(toRenderResponse);
  }

  /** Who is asking, for the access trail and for the site scope. */
  private requester(req: Request, permission: Permission): Requester {
    const scope = this.currentUser.requirePrincipal().sitesFor(permission);

    return {
      userId: this.currentUser.requireUserId(),
      sites: scope === ALL_SITES ? 'all' : scope,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}

function isAllowedHere(kind: string): kind is ClinicalDocumentKind {
  return (CLINICAL_DOCUMENT_KINDS as readonly string[]).includes(kind);
}

/**
 * `inline` and not `attachment`: the ordinary act is «ver e imprimir», and a
 * forced download puts a PDF of somebody's chart in the Downloads folder of
 * every machine in the clinic.
 */
export function sendPdf(res: Response, rendered: RenderedDocument): void {
  res
    .status(HttpStatus.OK)
    .setHeader('Content-Type', rendered.mimeType)
    .setHeader('Content-Length', rendered.content.byteLength)
    .setHeader('Content-Disposition', `inline; filename="${rendered.fileName}"`)
    // The chart of a person: never in a shared cache, never on disk.
    .setHeader('Cache-Control', 'no-store, private')
    .end(rendered.content);
}

export function sendStored(res: Response, stored: StoredDocument): void {
  res
    .status(HttpStatus.OK)
    .setHeader('Content-Type', stored.mimeType)
    .setHeader('Content-Length', stored.byteSize)
    .setHeader(
      'Content-Disposition',
      `inline; filename="${stored.kind.toLowerCase().replace(/_/g, '-')}-${stored.id}.pdf"`,
    )
    // An immutable artefact: the hash IS the validator, and it never changes.
    .setHeader('ETag', `"${stored.sha256}"`)
    .setHeader('Cache-Control', 'no-store, private')
    .end(stored.content);
}
