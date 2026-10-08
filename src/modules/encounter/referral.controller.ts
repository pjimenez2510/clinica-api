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
import type { Permission } from '../../shared/authorisation/permission.catalogue';
import { ALL_SITES } from '../../shared/authorisation/principal';
import { RequirePermission } from '../../shared/http/auth.decorators';

import type { Requester } from './application/encounter.service';
import { ReferralService } from './application/referral.service';
import type {
  InterconsultationView,
  ReferralView,
} from './domain/referral.repository';
import {
  CancelActDto,
  InterconsultationDto,
  IssueInterconsultationDto,
  IssueReferralDto,
  ReferralDto,
  ReferralSheetDto,
  type InterconsultationResponse,
  type ReferralResponse,
  type ReferralSheetResponse,
} from './dto/referral.dto';

/**
 * Referral, counter-referral, derivation, reverse referral and the
 * interconsultation of one attention (encounter H8, EN-100 to EN-107).
 *
 * Issuing a referral asks for `record:sign` —its 053 is signed— and an
 * interconsultation for `record:write`, as the SPEC's table of routes says;
 * reading, `record:read`. Each with its scope at the attention's site.
 */
@ApiTags('encounter')
@Controller({ path: 'encounters/:encounterId', version: '1' })
export class ReferralController {
  constructor(
    private readonly referrals: ReferralService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** EN-100 to EN-103. What the attention issued and what may be answered. */
  @Get('referrals')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Consultar las referencias e interconsultas de la atención' }) // prettier-ignore
  @ApiOkResponse({ type: ReferralSheetDto })
  async sheet(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Req() req: Request,
  ): Promise<ReferralSheetResponse> {
    const sheet = await this.referrals.sheetOf(
      encounterId,
      this.requester(req, 'record:read'),
    );
    return {
      referrals: sheet.referrals.map(toReferralResponse),
      interconsultations: sheet.interconsultations.map(
        toInterconsultationResponse,
      ),
      answerable: sheet.answerable.map((row) => ({
        id: row.id,
        direction: row.direction,
        destinationName: row.destinationName,
        reason: row.reason,
        issuedAt: row.issuedAt.toISOString(),
      })),
    };
  }

  /** EN-100 to EN-102, EN-104, EN-106. */
  @Post('referrals')
  @RequirePermission('record:sign', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Emitir una referencia, derivación, contrarreferencia o referencia inversa' }) // prettier-ignore
  @ApiCreatedResponse({ type: ReferralDto })
  async issueReferral(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: IssueReferralDto,
    @Req() req: Request,
  ): Promise<ReferralResponse> {
    return toReferralResponse(
      await this.referrals.issueReferral(
        encounterId,
        {
          direction: dto.direction,
          destination: dto.destination
            ? { mspUnicode: dto.destination.mspUnicode, name: dto.destination.name } // prettier-ignore
            : null,
          specialtyId: dto.specialtyId ?? null,
          priority: dto.priority,
          reason: dto.reason,
          summary: dto.summary,
          respondsToId: dto.respondsToId ?? null,
        },
        this.requester(req, 'record:sign'),
      ),
    );
  }

  /** EN-105, EN-107. */
  @Post('referrals/:referralId/cancel')
  @RequirePermission('record:sign', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anular una referencia emitida por error' })
  @ApiOkResponse({ type: ReferralDto })
  async cancelReferral(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('referralId', ParseUUIDPipe) referralId: string,
    @Body() dto: CancelActDto,
    @Req() req: Request,
  ): Promise<ReferralResponse> {
    return toReferralResponse(
      await this.referrals.cancelReferral(
        encounterId,
        referralId,
        dto.reason,
        this.requester(req, 'record:sign'),
      ),
    );
  }

  /** EN-103, EN-104, EN-106. */
  @Post('interconsultations')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Solicitar una interconsulta o registrar la recibida' }) // prettier-ignore
  @ApiCreatedResponse({ type: InterconsultationDto })
  async issueInterconsultation(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: IssueInterconsultationDto,
    @Req() req: Request,
  ): Promise<InterconsultationResponse> {
    return toInterconsultationResponse(
      await this.referrals.issueInterconsultation(
        encounterId,
        dto.role === 'REQUESTED'
          ? {
              role: 'REQUESTED',
              specialtyId: dto.specialtyId ?? null,
              reason: dto.reason,
              findings: dto.findings,
            }
          : {
              role: 'RECEIVED',
              // Present: the DTO refuses a RECEIVED one without them.
              requestedByName: dto.requestedByName ?? '',
              reason: dto.reason,
              findings: dto.findings,
              opinion: dto.opinion ?? '',
            },
        this.requester(req, 'record:write'),
      ),
    );
  }

  /** EN-107. */
  @Post('interconsultations/:interconsultationId/cancel')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Anular una interconsulta registrada por error' })
  @ApiOkResponse({ type: InterconsultationDto })
  async cancelInterconsultation(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('interconsultationId', ParseUUIDPipe) interconsultationId: string,
    @Body() dto: CancelActDto,
    @Req() req: Request,
  ): Promise<InterconsultationResponse> {
    return toInterconsultationResponse(
      await this.referrals.cancelInterconsultation(
        encounterId,
        interconsultationId,
        dto.reason,
        this.requester(req, 'record:write'),
      ),
    );
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

function cancellationOf(
  cancellation: ReferralView['cancellation'],
): ReferralResponse['cancellation'] {
  return cancellation && { ...cancellation, at: cancellation.at.toISOString() };
}

function toReferralResponse(view: ReferralView): ReferralResponse {
  return {
    id: view.id,
    encounterId: view.encounterId,
    direction: view.direction,
    status: view.status,
    destination: view.destination,
    specialty: view.specialty,
    priority: view.priority,
    reason: view.reason,
    summary: view.summary,
    respondsToId: view.respondsToId,
    answeredById: view.answeredById,
    clinicalNoteId: view.clinicalNoteId,
    issuedByName: view.issuedBy.name,
    issuedAt: view.issuedAt.toISOString(),
    cancellation: cancellationOf(view.cancellation),
  };
}

function toInterconsultationResponse(
  view: InterconsultationView,
): InterconsultationResponse {
  return {
    id: view.id,
    encounterId: view.encounterId,
    role: view.role,
    status: view.status,
    specialty: view.specialty,
    requestedByName: view.requestedByName,
    reason: view.reason,
    findings: view.findings,
    opinion: view.opinion,
    respondedByName: view.respondedByName,
    clinicalNoteId: view.clinicalNoteId,
    requestedAt: view.requestedAt.toISOString(),
    cancellation: cancellationOf(view.cancellation),
  };
}
