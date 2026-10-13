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
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { CurrentUserService } from '../../shared/authorisation/current-user.service';
import { ALL_SITES } from '../../shared/authorisation/principal';
import type { Permission } from '../../shared/authorisation/permission.catalogue';
import { AnnouncesChange } from '../../shared/events/announces-change';
import { RequirePermission } from '../../shared/http/auth.decorators';

import {
  SigningCertificateService,
  type CheckedCertificate,
} from './application/signing-certificate.service';
import { VoucherMonitorService } from './application/voucher-monitor.service';
import type { Requester } from './application/voucher-monitor.service';
import { VoucherRenumberingService } from './application/voucher-renumbering.service';
import { ElectronicVoucherNotFoundError } from './domain/sri.errors';
import {
  CertificateDto,
  RenumberedDto,
  ResendVoucherDto,
  SriMonitorDto,
  SriTransportFailureDto,
  UploadCertificateDto,
  type CertificateResponse,
  type RenumberedResponse,
  type SriMonitorResponse,
  type SriTransportFailureResponse,
} from './dto/sri.dto';

function toCertificate(summary: CheckedCertificate): CertificateResponse {
  return {
    id: summary.id,
    subject: summary.subject,
    issuer: summary.issuer,
    serialNumber: summary.serialNumber,
    notBefore: summary.notBefore.toISOString(),
    notAfter: summary.notAfter.toISOString(),
    active: summary.active,
    createdAt: summary.createdAt.toISOString(),
    holderRuc: summary.holderRuc,
    holderRucMatchesIssuer: summary.holderRucMatchesIssuer,
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
    private readonly renumbering: VoucherRenumberingService,
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
        renumberedFrom: row.renumberedFrom.map((renumbering) => ({
          previousNumber: renumbering.previousNumber,
          newSequential: renumbering.newSequential,
          renumberedAt: renumbering.renumberedAt.toISOString(),
          renumberedByName: renumbering.renumberedByName,
          sriMessage: renumbering.sriMessage,
        })),
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
      deliveryStalled: {
        count: view.deliveryStalled.count,
        oldestAuthorisedAt:
          view.deliveryStalled.oldestAuthorisedAt?.toISOString() ?? null,
      },
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

  /** SRI-109, SRI-110. «Renumerar con el siguiente libre». */
  @Post(':voucherId/renumber')
  @HttpCode(HttpStatus.OK)
  @AnnouncesChange('billing')
  @RequirePermission('billing:write', 'query')
  @ApiOperation({
    summary:
      'Dar el siguiente número a un comprobante que el SRI devolvió con «secuencial registrado» (45)',
  })
  @ApiOkResponse({ type: RenumberedDto })
  async renumber(
    @Param('voucherId', ParseUUIDPipe) voucherId: string,
    @Req() req: Request,
  ): Promise<RenumberedResponse> {
    const renumbered = await this.renumbering.renumber(
      voucherId,
      this.requester(req, 'billing:write'),
    );
    return {
      previousSequential: renumbered.previousSequential,
      newSequential: renumbered.newSequential,
    };
  }

  /** SRI-095, SRI-096. A copy to another address; the voucher does not move. */
  @Post(':voucherId/resend')
  // SRI-095. Sent with somebody at the desk: a handful a minute is plenty, and
  // a script walking the site's vouchers to an outside address is not.
  @Throttle({ short: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  // SRI-099. Caja and administration: the e-mail only.
  @RequirePermission('billing:voucher-mail', 'query')
  @ApiOperation({
    summary:
      'Reenviar por correo el RIDE y el XML de un comprobante autorizado a otra dirección',
  })
  @ApiNoContentResponse()
  async resend(
    @Param('voucherId', ParseUUIDPipe) voucherId: string,
    @Body() dto: ResendVoucherDto,
    @Req() req: Request,
  ): Promise<void> {
    // SRI-099 (D-167 §2). Who issues and collects re-sends any authorised
    // voucher; administration only one whose e-mail did not go.
    const issuing = this.currentUser
      .requirePrincipal()
      .sitesFor('billing:write');
    await this.monitorService.resendTo(
      voucherId,
      dto.email,
      this.requester(req, 'billing:voucher-mail'),
      issuing === ALL_SITES ? 'all' : issuing,
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
