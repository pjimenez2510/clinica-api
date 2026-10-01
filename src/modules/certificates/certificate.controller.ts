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
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import type { Permission } from '../../shared/authorisation/permission.catalogue';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { CertificateService } from './application/certificate.service';
import type { Requester } from './application/certificate.service';
import { toCertificateResponse } from './certificate.presenter';
import {
  CertificateDto,
  RevokeCertificateDto,
  type CertificateResponse,
} from './dto/certificate.dto';

/**
 * One certificate: reading it and annulling it.
 *
 * CER-015. Reading is `record:read`; annulling is `record:write`, the same
 * permission that issues.
 */
@ApiTags('certificates')
@Controller({ path: 'certificates', version: '1' })
export class CertificateController {
  constructor(
    private readonly certificates: CertificateService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** CER-010, CER-016. One certificate, audited. */
  @Get(':certificateId')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Obtener un certificado médico' })
  @ApiOkResponse({ type: CertificateDto })
  async findOne(
    @Param('certificateId', ParseUUIDPipe) certificateId: string,
    @Req() req: Request,
  ): Promise<CertificateResponse> {
    const certificate = await this.certificates.findOne(
      certificateId,
      this.requester(req, 'record:read'),
    );
    return toCertificateResponse(certificate);
  }

  /**
   * CER-011, CER-012, CER-016. Annuls a certificate with a written reason.
   * NOTHING IS DELETED. 200: what comes back is the certificate in its new
   * state.
   */
  @Post(':certificateId/revoke')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anular un certificado médico, diciendo por qué' })
  @ApiOkResponse({ type: CertificateDto })
  async revoke(
    @Param('certificateId', ParseUUIDPipe) certificateId: string,
    @Body() body: RevokeCertificateDto,
    @Req() req: Request,
  ): Promise<CertificateResponse> {
    const revoked = await this.certificates.revoke(
      certificateId,
      body.reason,
      this.requester(req, 'record:write'),
    );
    return toCertificateResponse(revoked);
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
