import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { DocumentService } from './application/document.service';
import { sendPdf } from './documents.controller';

/**
 * DOC-118, DOC-119 (D-198 §1). The certified copy of the clinical record, from
 * the request of `privacy` that authorised it.
 *
 * `patient:data-requests` AND THE KEY OF THE RECORD (D-203 §1, decided by the
 * author on 10-10-2026): one person may register, authorise and download the
 * copy, but only holding `record:read` at the patient's site, and the copy
 * reaches the sites of that `record:read`. Without it the route answers as if
 * the request did not exist. No copy leaves without a copy request whose
 * answer granted it (EN-033), and every one leaves its `EXPORT` rows.
 */
function recordScopeOf(currentUser: CurrentUserService): 'all' | string[] {
  const scope = currentUser.requirePrincipal().sitesFor('record:read');
  return scope === ALL_SITES ? 'all' : scope;
}

@ApiTags('documents')
@Controller({ path: 'documents', version: '1' })
export class ClinicalRecordCopyController {
  constructor(
    private readonly documents: DocumentService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get('data-requests/:requestId/clinical-record')
  @RequirePermission('patient:data-requests', 'global')
  @ApiOperation({ summary: 'Descargar la copia certificada de la historia clínica de una solicitud atendida (se genera al momento y no se archiva)' }) // prettier-ignore
  @ApiProduces('application/pdf')
  async clinicalRecordCopy(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const rendered = await this.documents.clinicalRecordCopy(requestId, {
      userId: this.currentUser.requireUserId(),
      // D-203 §1. The copy reaches the sites of the caller's `record:read`.
      sites: recordScopeOf(this.currentUser),
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    sendPdf(res, rendered);
  }
}
