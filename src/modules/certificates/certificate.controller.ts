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
import {
  toCertificateResponse,
  toForm117Response,
} from './certificate.presenter';
import {
  MedicalCertificateDto,
  Form117Dto,
  RevokeCertificateDto,
  type CertificateResponse,
  type Form117Response,
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

  /**
   * CER-010, CER-016, CER-020 to CER-029. One certificate as the five blocks
   * of form 117. Audited: it is what is printed and handed over.
   */
  @Get(':certificateId')
  @RequirePermission('record:read', 'query')
  @ApiOperation({
    summary:
      'Obtener el certificado médico con el contenido del formulario 117',
  })
  @ApiOkResponse({ type: Form117Dto })
  async form117(
    @Param('certificateId', ParseUUIDPipe) certificateId: string,
    @Req() req: Request,
  ): Promise<Form117Response> {
    const form = await this.certificates.form117(
      certificateId,
      this.requester(req, 'record:read'),
    );
    return toForm117Response(form);
  }

  /**
   * CER-011, CER-012, CER-016, CER-040. Annuls a certificate with a written
   * reason, if the caller issued it or directs its site.
   * NOTHING IS DELETED. 200: what comes back is the certificate in its new
   * state.
   */
  @Post(':certificateId/revoke')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anular un certificado médico, diciendo por qué' })
  @ApiOkResponse({ type: MedicalCertificateDto })
  async revoke(
    @Param('certificateId', ParseUUIDPipe) certificateId: string,
    @Body() body: RevokeCertificateDto,
    @Req() req: Request,
  ): Promise<CertificateResponse> {
    const direction = this.currentUser
      .requirePrincipal()
      .sitesFor('certificate:revoke-any');
    const revoked = await this.certificates.revoke(
      certificateId,
      body.reason,
      this.requester(req, 'record:write'),
      // CER-040. Where the caller is the medical direction; often nowhere.
      direction === ALL_SITES ? 'all' : direction,
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
