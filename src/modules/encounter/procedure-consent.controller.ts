import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { RequirePermission } from '../../shared/http/auth.decorators';

import type { Requester } from './application/encounter.service';
import { ProcedureConsentService } from './application/procedure-consent.service';
import type {
  ProcedureConsentView,
  RefusalView,
  Representative,
} from './domain/procedure-consent';
import {
  ConsentRequirementDto,
  ConsentRequirementQueryDto,
  ProcedureConsentDto,
  RecordRefusalDto,
  RefusalDto,
  RevokeConsentDto,
  type ProcedureConsentResponse,
  type RefusalResponse,
} from './dto/clinical-coding.dto';

/**
 * The form 024 beyond the procedure's own registration (EN-152 to EN-154,
 * D-159): the screen's question, the refusal and the revocation.
 *
 * `record:write` like the procedures, and `'query'` site scope like the rest
 * of the module: the attention is addressed by id and the handler narrows
 * with the caller's own resolved scope (EN-121). Registering the procedure
 * WITH its 024 is `POST …/procedures`, in `ClinicalCodingController`.
 */
@ApiTags('encounter')
@Controller({ path: 'encounters/:encounterId', version: '1' })
export class ProcedureConsentController {
  constructor(
    private readonly consents: ProcedureConsentService,
    private readonly currentUser: CurrentUserService,
  ) {}

  /** EN-152. «¿Este procedimiento exige el 024?», when the doctor picks it. */
  @Get('procedure-consent-requirement')
  @RequirePermission('record:read', 'query')
  @ApiOperation({ summary: 'Saber si un procedimiento exige el consentimiento informado escrito (024)' }) // prettier-ignore
  @ApiOkResponse({ type: ConsentRequirementDto })
  requirement(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Query() query: ConsentRequirementQueryDto,
    @Req() req: Request,
  ): Promise<{ required: boolean }> {
    return this.consents.requirement(
      encounterId,
      query.conceptId,
      this.requester(req, 'record:read'),
    );
  }

  /** EN-153. The patient refused the intervention. 201: a row that did not exist. */
  @Post('procedure-refusals')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Registrar la negativa del paciente a una intervención' }) // prettier-ignore
  @ApiCreatedResponse({ type: RefusalDto })
  async recordRefusal(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Body() dto: RecordRefusalDto,
    @Req() req: Request,
  ): Promise<RefusalResponse> {
    const refusal = await this.consents.recordRefusal(
      encounterId,
      {
        conceptId: dto.conceptId,
        signer: dto.signer,
        representative: representativeOf(dto.representative),
        witness: dto.witness ?? null,
        refusedAt:
          dto.refusedAt === undefined ? undefined : new Date(dto.refusedAt),
      },
      this.requester(req, 'record:write'),
    );
    return toRefusalResponse(refusal);
  }

  /** EN-154. The revocation of a signed consent; 200 with the consent and it. */
  @Post('procedure-consents/:consentId/revoke')
  @RequirePermission('record:write', 'query')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Registrar la revocación de un consentimiento firmado' }) // prettier-ignore
  @ApiOkResponse({ type: ProcedureConsentDto })
  async revoke(
    @Param('encounterId', ParseUUIDPipe) encounterId: string,
    @Param('consentId', ParseUUIDPipe) consentId: string,
    @Body() dto: RevokeConsentDto,
    @Req() req: Request,
  ): Promise<ProcedureConsentResponse> {
    const consent = await this.consents.revoke(
      encounterId,
      consentId,
      {
        signer: dto.signer,
        representative: representativeOf(dto.representative),
      },
      this.requester(req, 'record:write'),
    );
    return toConsentResponse(consent);
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

/** The body's representative, with its document `null` when absent. */
export function representativeOf(
  representative:
    | {
        name: string;
        relationship: Representative['relationship'];
        document?: string | null;
      }
    | null
    | undefined,
): Representative | null {
  return representative == null
    ? null
    : {
        name: representative.name,
        relationship: representative.relationship,
        document: representative.document ?? null,
      };
}

/** Instants leave as ISO 8601; the client renders them in Ecuadorian time. */
export function toConsentResponse(
  consent: ProcedureConsentView,
): ProcedureConsentResponse {
  return {
    id: consent.id,
    kind: consent.kind,
    signer: consent.signer,
    representative: consent.representative,
    exceptionKind: consent.exceptionKind,
    exceptionReason: consent.exceptionReason,
    informedBy: consent.informedBy,
    signedAt: consent.signedAt?.toISOString() ?? null,
    recordedAt: consent.recordedAt.toISOString(),
    recordedBy: consent.recordedBy,
    revocation:
      consent.revocation === null
        ? null
        : {
            signer: consent.revocation.signer,
            representative: consent.revocation.representative,
            revokedAt: consent.revocation.revokedAt.toISOString(),
            revokedBy: consent.revocation.revokedBy,
          },
  };
}

/** EN-153. The witness travels as written: name and document. */
export function toRefusalResponse(refusal: RefusalView): RefusalResponse {
  return {
    id: refusal.id,
    conceptId: refusal.conceptId,
    procedureCode: refusal.procedureCode,
    procedureDisplay: refusal.procedureDisplay,
    signer: refusal.signer,
    representative: refusal.representative,
    witness: refusal.witness,
    informedBy: refusal.informedBy,
    refusedAt: refusal.refusedAt.toISOString(),
    recordedBy: refusal.recordedBy,
  };
}
