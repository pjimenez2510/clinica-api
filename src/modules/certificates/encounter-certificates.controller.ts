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
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import type { Permission } from '../../shared/authorisation/permission.catalogue';
import type { ClinicalDate } from '../../shared/domain/clinic-time';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { CertificateService } from './application/certificate.service';
import type { Requester } from './application/certificate.service';
import { toCertificateResponse, toIessResponse } from './certificate.presenter';
import {
  CertificateListDto,
  IssueCertificateDto,
  IssuedCertificateDto,
  type CertificateListResponse,
  type IssuedCertificateResponse,
} from './dto/certificate.dto';
import type { CertificateType } from './domain/certificate';

/**
 * The certificates of one attention: issuing them and listing them.
 *
 * CER-015. `record:write` to issue — the permission only `MEDICO` carries, and
 * the instructivo says the 117 is filled in by «profesionales médicos
 * especialistas, generales» — and `record:read` to read.
 *
 * ⚠️ EVERY ROUTE DECLARES `'query'` SITE SCOPE: the certificate hangs off an
 * attention, the site is not in the URL, and the handler narrows with the
 * caller's own resolved scope.
 */
@ApiTags('certificates')
@Controller({ path: 'encounters/:encounterId/certificates', version: '1' })
export class EncounterCertificatesController {
  constructor(
    private readonly certificates: CertificateService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /**
   * CER-001 to CER-009, CER-013. Issues a certificate of attendance or of
   * rest. 201: what it leaves behind is a row that did not exist.
   */
  @Post()
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Emitir un certificado médico desde la atención' })
  @ApiCreatedResponse({ type: IssuedCertificateDto })
  async issue(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: IssueCertificateDto,
    @Req() req: Request,
  ): Promise<IssuedCertificateResponse> {
    const issued = await this.certificates.issue(
      {
        encounterId,
        type: dto.type as CertificateType,
        // Validated as calendar dates by the DTO.
        restFrom: (dto.restFrom ?? null) as ClinicalDate | null,
        restTo: (dto.restTo ?? null) as ClinicalDate | null,
        includeDiagnosis: dto.includeDiagnosis,
      },
      this.requester(req, 'record:write'),
    );

    return {
      certificate: toCertificateResponse(issued.certificate),
      iess: toIessResponse(issued.iess),
    };
  }

  /** CER-010, CER-016. The certificates of one attention, newest first. */
  @Get()
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Listar los certificados médicos de la atención' })
  @ApiOkResponse({ type: CertificateListDto })
  async list(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<CertificateListResponse> {
    const items = await this.certificates.listOfEncounter(
      encounterId,
      this.requester(req, 'record:read'),
    );
    return { items: items.map(toCertificateResponse) };
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
