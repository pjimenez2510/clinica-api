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
import { RequirePermission } from '../../shared/http/auth.decorators';

import { DocumentService } from './application/document.service';
import { sendPdf } from './documents.controller';

/**
 * DOC-118, DOC-119 (D-198 §1). The certified copy of the clinical record, from
 * the request of `privacy` that authorised it.
 *
 * ⚠️ `patient:data-requests` AND NOT `record:read`: the copy is handed over by
 * whoever answers the requests about a patient's data —the custodian's desk—,
 * like the export that already carries the clinical versions (PD-048). Whether
 * that desk should also hold `record:read` is D-140.2, with the legal adviser.
 * What keeps it narrow is the request: no copy leaves without a copy request
 * whose answer granted it (EN-033), and every one leaves its `EXPORT` rows.
 *
 * Global, like every route of `privacy` (PA-051): the record is one across
 * the sites.
 */
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
      // The request is global: no site narrows what the copy reads.
      sites: 'all',
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    sendPdf(res, rendered);
  }
}
