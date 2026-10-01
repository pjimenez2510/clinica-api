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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import type { Permission } from '../../shared/authorisation/permission.catalogue';
import { RequirePermission } from '../../shared/http/auth.decorators';

import { SigningCertificateService } from './application/signing-certificate.service';
import { VoucherMonitorService } from './application/voucher-monitor.service';
import type { Requester } from './application/voucher-monitor.service';
import type { CertificateSummary } from './domain/electronic-voucher.repository';
import { ElectronicVoucherNotFoundError } from './domain/sri.errors';
import {
  CertificateDto,
  SriMonitorDto,
  SriTransportFailureDto,
  UploadCertificateDto,
  type CertificateResponse,
  type SriMonitorResponse,
  type SriTransportFailureResponse,
} from './dto/sri.dto';

function toCertificate(summary: CertificateSummary): CertificateResponse {
  return {
    id: summary.id,
    subject: summary.subject,
    issuer: summary.issuer,
    serialNumber: summary.serialNumber,
    notBefore: summary.notBefore.toISOString(),
    notAfter: summary.notAfter.toISOString(),
    active: summary.active,
    createdAt: summary.createdAt.toISOString(),
  };
}

/**
 * SRI-058, SRI-060 to SRI-068. What caja sees of the SRI.
 *
 * `billing:read` to look and `billing:write` to retry (SRI-064): no new
 * permission, because the monitor shows nothing a cashier could not already
 * read, and retrying is re-issuing what they issued.
 */
@ApiTags('sri')
@Controller({ path: 'sri/vouchers', version: '1' })
export class SriVouchersController {
  constructor(
    private readonly monitorService: VoucherMonitorService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** SRI-061 to SRI-063. */
  @Get()
  @RequirePermission('billing:read', 'query')
  @ApiOperation({
    summary: 'Comprobantes electrónicos no autorizados, con su motivo',
  })
  @ApiOkResponse({ type: SriMonitorDto })
  async monitor(@Req() req: Request): Promise<SriMonitorResponse> {
    const view = await this.monitorService.monitor(
      this.requester(req, 'billing:read').sites,
    );
    return {
      rows: view.rows.map((row) => ({
        ...row,
        issuedAt: row.issuedAt.toISOString(),
        nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
        receivedAt: row.receivedAt?.toISOString() ?? null,
        lastTransportFailure: row.lastTransportFailure
          ? {
              ...row.lastTransportFailure,
              at: row.lastTransportFailure.at.toISOString(),
            }
          : null,
      })),
      certificate: {
        ...view.certificate,
        active: view.certificate.active
          ? {
              notBefore: view.certificate.active.notBefore.toISOString(),
              notAfter: view.certificate.active.notAfter.toISOString(),
            }
          : null,
      },
      webServiceConfigured: view.webServiceConfigured,
    };
  }

  /** SRI-058, SRI-066. */
  @Post(':voucherId/retry')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('billing:write', 'query')
  @ApiOperation({
    summary:
      'Reenviar al SRI un comprobante devuelto o no autorizado, con la misma clave',
  })
  @ApiNoContentResponse()
  async retry(
    @Param('voucherId', ParseUUIDPipe) voucherId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.monitorService.retry(
      voucherId,
      this.requester(req, 'billing:write'),
    );
  }

  /** SRI-069, SRI-065. */
  @Get(':voucherId/transport-failure')
  @RequirePermission('billing:read', 'query')
  @ApiOperation({
    summary:
      'Lo que contestó el SRI en el último intento fallido, con el cuerpo tal como llegó',
  })
  @ApiOkResponse({ type: SriTransportFailureDto })
  async transportFailure(
    @Param('voucherId', ParseUUIDPipe) voucherId: string,
    @Req() req: Request,
  ): Promise<SriTransportFailureResponse> {
    const failure = await this.monitorService.lastTransportFailure(
      voucherId,
      this.requester(req, 'billing:read').sites,
    );
    return {
      failure: failure ? { ...failure, at: failure.at.toISOString() } : null,
    };
  }

  /** SRI-068. */
  @Get(':voucherId/xml/:kind')
  @RequirePermission('billing:read', 'query')
  @ApiOperation({ summary: 'Descargar el XML firmado o el autorizado' })
  @ApiProduces('application/xml')
  async xml(
    @Param('voucherId', ParseUUIDPipe) voucherId: string,
    @Param('kind') kind: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (kind !== 'firmado' && kind !== 'autorizado') {
      throw new ElectronicVoucherNotFoundError();
    }
    const file = await this.monitorService.xml(
      voucherId,
      kind === 'autorizado' ? 'authorised' : 'signed',
      this.requester(req, 'billing:read').sites,
    );
    res
      .status(HttpStatus.OK)
      .setHeader('Content-Type', 'application/xml; charset=utf-8')
      .setHeader(
        'Content-Disposition',
        `attachment; filename="${file.fileName}"`,
      )
      .setHeader('Cache-Control', 'no-store, private')
      .end(file.content);
  }

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

/**
 * SRI-080 to SRI-084. The issuer's certificate, under `config:manage`: a datum
 * of the installation, administered by whoever configures it (SRI-082). The
 * response never carries the file or its password — the summary type cannot.
 */
@ApiTags('sri')
@Controller({ path: 'sri/certificates', version: '1' })
export class SriCertificatesController {
  constructor(
    private readonly certificates: SigningCertificateService,
    private readonly currentUser: CurrentUserService,
  ) {}

  @Get()
  @RequirePermission('config:manage', 'global')
  @ApiOperation({
    summary: 'Certificados de firma del emisor, sin su contenido',
  })
  @ApiOkResponse({ type: [CertificateDto] })
  async list(): Promise<CertificateResponse[]> {
    return (await this.certificates.list()).map(toCertificate);
  }

  @Post()
  @RequirePermission('config:manage', 'global')
  @ApiOperation({ summary: 'Cargar el .p12 del emisor y activarlo' })
  @ApiCreatedResponse({ type: CertificateDto })
  async upload(
    @Body() body: UploadCertificateDto,
    @Req() req: Request,
  ): Promise<CertificateResponse> {
    const summary = await this.certificates.upload(
      Buffer.from(body.pkcs12Base64, 'base64'),
      body.password,
      {
        userId: this.currentUser.requireUserId(),
        ip: req.ip,
        userAgent: req.get('user-agent'),
      },
    );
    return toCertificate(summary);
  }
}
