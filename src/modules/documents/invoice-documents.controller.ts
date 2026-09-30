import {
  Controller,
  Get,
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
import { toRenderResponse } from './documents.presenter';
import { sendStored } from './documents.controller';
import {
  DocumentRenderDto,
  type DocumentRenderResponse,
} from './dto/documents.dto';
import type { Requester } from './application/document.service';
import type { DocumentKind } from './domain/document-kind';

/**
 * DOC-090. The one kind these routes may serve.
 *
 * An artefact is found by an identifier that says nothing about its class, so
 * without this a caller holding `billing:read` could fetch a receta by passing
 * its id here: the permission is on the ROUTE and the kind is in the ROW.
 */
const RIDE_ONLY = ['INVOICE_RIDE'] as const satisfies readonly DocumentKind[];

/**
 * The RIDE: the printable representation of the electronic invoice.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A CONTROLLER OF ITS OWN, AND THE REASON IS THE PERMISSION (DOC-090)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A route declares ONE permission, and these have to declare `billing:read`
 * while the clinical documents declare `record:read`. Folding the four kinds
 * into one controller would mean choosing one of the two — and either choice
 * hands a chart to whoever bills or an invoice to whoever attends. The split is
 * not tidiness: it is the authorisation boundary made structural.
 *
 * ⚠️ NO QR AND NO BARCODE ARE PRINTED, AND THAT IS A REQUIREMENT (DOC-078).
 * «QR» does not appear once in the 142 pages of the SRI's Ficha Técnica, and
 * the barcode is explicitly optional. Both are what somebody adds from memory
 * after seeing other RIDEs.
 *
 * ⚠️ AND ISSUING THE RIDE IS NOT ISSUING THE INVOICE. The voucher is the
 * electronic document `billing` sends to the SRI; this is the sheet the
 * customer is handed. Emitting it changes nothing about the invoice.
 */
@ApiTags('documents')
@Controller({ path: 'documents/ride', version: '1' })
export class InvoiceDocumentsController {
  constructor(
    private readonly documents: DocumentService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** DOC-076, DOC-077. Emits and files the RIDE of one invoice. */
  @Post('invoices/:invoiceId')
  @RequirePermission('billing:read', 'query')
  @ApiOperation({ summary: 'Emitir y archivar el RIDE de una factura' })
  @ApiCreatedResponse({ type: DocumentRenderDto })
  async emit(
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Req() req: Request,
  ): Promise<DocumentRenderResponse> {
    const stored = await this.documents.emit(
      { kind: 'INVOICE_RIDE', subjectId: invoiceId },
      this.requester(req),
    );
    return toRenderResponse(stored);
  }

  /** DOC-092. The metadata of an archived RIDE. */
  @Get(':renderId')
  @RequirePermission('billing:read', 'query')
  @ApiOperation({ summary: 'Consultar los datos del RIDE archivado' })
  @ApiOkResponse({ type: DocumentRenderDto })
  async metadata(
    @Param('renderId', ParseUUIDPipe) renderId: string,
    @Req() req: Request,
  ): Promise<DocumentRenderResponse> {
    const summary = await this.documents.metadata(
      renderId,
      RIDE_ONLY,
      this.requester(req),
    );
    return toRenderResponse(summary);
  }

  /** DOC-006. Reprinting: the stored bytes, never a recomposition. */
  @Get(':renderId/content')
  @RequirePermission('billing:read', 'query')
  @ApiOperation({ summary: 'Descargar el RIDE archivado, tal como se emitió' })
  @ApiProduces('application/pdf')
  async content(
    @Param('renderId', ParseUUIDPipe) renderId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const stored = await this.documents.content(
      renderId,
      RIDE_ONLY,
      this.requester(req),
    );
    sendStored(res, stored);
  }

  private requester(req: Request): Requester {
    const permission: Permission = 'billing:read';
    const scope = this.currentUser.requirePrincipal().sitesFor(permission);

    return {
      userId: this.currentUser.requireUserId(),
      sites: scope === ALL_SITES ? 'all' : scope,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };
  }
}
